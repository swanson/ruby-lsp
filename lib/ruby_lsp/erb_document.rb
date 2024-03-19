# typed: strict
# frozen_string_literal: true

module RubyLsp
  class ERBDocument < Document
    extend T::Sig

    sig { override.returns(Prism::ParseResult) }
    def parse
      return @parse_result unless @needs_parsing

      @needs_parsing = false
      scanner = ERBScanner.new(@source)
      scanner.scan
      @parse_result = Prism.parse(scanner.ruby)
    end

    sig { override.returns(T::Boolean) }
    def typechecker_enabled?
      false
    end

    class ERBScanner
      extend T::Sig

      sig { returns(String) }
      attr_reader :ruby, :html

      sig { params(source: String).void }
      def initialize(source)
        @source = source
        @html = +""
        @ruby = +""
        @current_pos = 0
        @inside_ruby = false
      end

      sig { void }
      def scan
        while @current_pos < @source.length
          scan_char
          @current_pos += 1
        end
      end

      private

      sig { void }
      def scan_char
        char = @source[@current_pos]

        case char
        when "<"
          if @source[@current_pos + 1] == "%"
            @inside_ruby = true
            @current_pos += 1
            push_char("  ")

            if @source[@current_pos + 1] == "="
              @current_pos += 1
              push_char(" ")
            end

            if @source[@current_pos + 1] == "-"
              @current_pos += 1
              push_char(" ")
            end
          else
            push_char(char)
          end
        when "-"
          if @inside_ruby && @source[@current_pos + 1] == "%" &&
              @source[@current_pos + 2] == ">"
            @current_pos += 2
            push_char("   ")
            @inside_ruby = false
          else
            push_char(char)
          end
        when "%"
          if @inside_ruby && @source[@current_pos + 1] == ">"
            @inside_ruby = false
            @current_pos += 1
            push_char("  ")
          else
            push_char(char)
          end
        when "\n"
          @ruby << char
          @html << char
        else
          push_char(char)
        end
      end

      sig { params(char: String).void }
      def push_char(char)
        if @inside_ruby
          @ruby << char
          @html << " " * char.length
        else
          @ruby << " " * char.length
          @html << char
        end
      end
    end
  end
end
