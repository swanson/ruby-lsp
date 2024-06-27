import * as vscode from "vscode";

import { Command } from "./common";
import { Workspace } from "./workspace";

const CHAT_AGENT_ID = "rubyLsp.chatAgent";

export class ChatAgent implements vscode.Disposable {
  private readonly agent: vscode.ChatParticipant;
  private readonly showWorkspacePick: () => Promise<Workspace | undefined>;

  constructor(
    context: vscode.ExtensionContext,
    showWorkspacePick: () => Promise<Workspace | undefined>,
  ) {
    this.agent = vscode.chat.createChatParticipant(
      CHAT_AGENT_ID,
      this.handler.bind(this),
    );
    this.agent.iconPath = vscode.Uri.joinPath(context.extensionUri, "icon.png");
    this.showWorkspacePick = showWorkspacePick;
  }

  dispose() {
    this.agent.dispose();
  }

  private async handler(
    request: vscode.ChatRequest,
    context: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ) {
    if (this.withinConversation("design", request, context)) {
      return this.runDesignCommand(request, context, stream, token);
    }

    stream.markdown(
      "Please indicate which command you would like to use for our chat.",
    );
    return { metadata: { command: "" } };
  }

  private async runDesignCommand(
    request: vscode.ChatRequest,
    context: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ) {
    const previousInteractions = this.previousInteractions(context);

    const messages = [
      vscode.LanguageModelChatMessage.User(`User prompt: ${request.prompt}`),
      vscode.LanguageModelChatMessage.User(
        [
          "You are a domain driven design expert.",
          "The user will provide you with details about their Rails application.",
          "The user will ask you to help model a single specific concept.",
          "Your job is to suggest a model name and attributes to model that concept.",
          "Include all Rails generate commands in a single Markdown shell code block at the end.",
          "Do not include commands to migrate the database as part of the code block.",
        ].join(" "),
      ),
      vscode.LanguageModelChatMessage.User(
        `Previous interactions with the user: ${previousInteractions}`,
      ),
    ];

    if (request.command) {
      const workspace = await this.showWorkspacePick();

      if (workspace) {
        stream.progress("Gathering project's existing schema");
        const schema = await this.gatherSchema(workspace);
        stream.progress("Filtering relevant parts of the schema");
        const filteredSchema = await this.filterSchema(
          request,
          schema,
          previousInteractions,
        );
        stream.progress(
          `Identified relevant models as ${Object.keys(filteredSchema)}...`,
        );
        const schemaString = Object.entries(filteredSchema)
          .map(([model, attributes]) => {
            return `${model}:\n${attributes}`;
          })
          .join("\n");

        messages.push(
          vscode.LanguageModelChatMessage.User(
            `Existing application schema: ${schemaString}`,
          ),
        );
      }
    }

    try {
      const [model] = await vscode.lm.selectChatModels({
        vendor: "copilot",
        family: "gpt-4-turbo",
      });
      stream.progress("Designing the models for the requested concept...");
      const chatResponse = await model.sendRequest(messages, {}, token);

      let response = "";
      for await (const fragment of chatResponse.text) {
        stream.markdown(fragment);
        response += fragment;
      }

      const match = /(?<=```shell)[^.$]*(?=```)/.exec(response);

      if (match && match[0]) {
        const commandList = match[0].trim().split("\n");
        stream.button({
          command: Command.RailsGenerate,
          title: "Generate with Rails",
          arguments: [commandList],
        });

        stream.button({
          command: Command.RailsGenerate,
          title: "Revert previous generation",
          arguments: [
            commandList.map((command) =>
              command.replace("generate", "destroy"),
            ),
          ],
        });
      }
    } catch (err) {
      this.handleError(err, stream);
    }

    return { metadata: { command: "design" } };
  }

  // Returns `true` if the current or any previous interactions with the chat match the given `command`. Useful for
  // ensuring that the user can continue chatting without having to re-type the desired command multiple times
  private withinConversation(
    command: string,
    request: vscode.ChatRequest,
    context: vscode.ChatContext,
  ) {
    return (
      request.command === command ||
      (!request.command &&
        context.history.some(
          (entry) =>
            entry instanceof vscode.ChatRequestTurn &&
            entry.command === command,
        ))
    );
  }

  private handleError(err: any, stream: vscode.ChatResponseStream) {
    // making the chat request might fail because
    // - model does not exist
    // - user consent not given
    // - quote limits exceeded
    if (err instanceof vscode.LanguageModelError) {
      if (
        err.cause instanceof Error &&
        err.cause.message.includes("off_topic")
      ) {
        stream.markdown(
          "Sorry, I can only help you with Ruby related questions",
        );
      }
    } else {
      // re-throw other errors so they show up in the UI
      throw err;
    }
  }

  // Get the content of all previous interactions (including requests and responses) as a string
  private previousInteractions(context: vscode.ChatContext): string {
    let history = "";

    context.history.forEach((entry) => {
      if (entry instanceof vscode.ChatResponseTurn) {
        if (entry.participant === CHAT_AGENT_ID) {
          let content = "";

          entry.response.forEach((part) => {
            if (part instanceof vscode.ChatResponseMarkdownPart) {
              content += part.value.value;
            }
          });

          history += `Response: ${content}`;
        }
      } else {
        history += `Request: ${entry.prompt}`;
      }
    });

    return history;
  }

  private async gatherSchema(workspace: Workspace) {
    const script = [
      'Dir.glob("app/models/**/*.rb").each { |file| require(File.expand_path(file.delete_suffix(".rb"))) }',
      "models = ActiveRecord::Base.descendants",
      "schema = models.each_with_object({}) do |model, hash|",
      "  next if model.abstract_class?",
      '  hash[model.name] = model.columns.map { |c| "  #{c.name}: #{c.type}" }.join("\n")',
      "end",
      "puts schema.to_json",
    ].join(";");

    const { stdout } = await workspace.runInWorkspace(
      `bin/rails runner "${script.replace(/"/g, '\\"')}"`,
    );

    return JSON.parse(stdout);
  }

  private async filterSchema(
    request: vscode.ChatRequest,
    schema: Record<string, string>,
    previousInteractions: string,
  ) {
    const [model] = await vscode.lm.selectChatModels({
      vendor: "copilot",
      family: "gpt-4-turbo",
    });

    const chatResponse = await model.sendRequest(
      [
        vscode.LanguageModelChatMessage.User(
          `Based on the provided schema and previous interactions, select the models from the given list that are most
          associated to the user's request`,
        ),
        vscode.LanguageModelChatMessage.User(
          "Respond only with the list of relevant models separated by commas and nothing else",
        ),
        vscode.LanguageModelChatMessage.User(`User prompt: ${request.prompt}`),
        vscode.LanguageModelChatMessage.User(
          `Previous interactions: ${previousInteractions}`,
        ),
        vscode.LanguageModelChatMessage.User(
          `Model list: ${Object.keys(schema).join(", ")}`,
        ),
      ],
      {},
    );

    let response = "";
    for await (const fragment of chatResponse.text) {
      response += fragment;
    }

    const filteredSchema: Record<string, string> = {};

    Object.entries(schema).forEach(([model, attributes]) => {
      if (response.includes(model)) {
        filteredSchema[model] = attributes;
      }
    });

    return filteredSchema;
  }
}
