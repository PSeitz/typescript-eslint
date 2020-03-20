import {
  AST_NODE_TYPES,
  TSESLint,
  TSESTree,
} from '@typescript-eslint/experimental-utils';
import { AST as RegExpAST, RegExpParser } from 'regexpp';
import {
  createRule,
  getParserServices,
  getPropertyName,
  getStaticValue,
  getTypeName,
  isNotClosingParenToken,
} from '../util';

const EQ_OPERATORS = /^[=!]=/;
const regexpp = new RegExpParser();

export default createRule({
  name: 'prefer-string-starts-ends-with',
  defaultOptions: [],

  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Enforce the use of `String#startsWith` and `String#endsWith` instead of other equivalent methods of checking substrings',
      category: 'Best Practices',
      recommended: 'error',
      requiresTypeChecking: true,
    },
    messages: {
      preferStartsWith: "Use 'String#startsWith' method instead.",
      preferEndsWith: "Use the 'String#endsWith' method instead.",
    },
    schema: [],
    fixable: 'code',
  },

  create(context) {
    const globalScope = context.getScope();
    const sourceCode = context.getSourceCode();
    const service = getParserServices(context);
    const typeChecker = service.program.getTypeChecker();

    /**
     * Check if a given node is a string.
     * @param node The node to check.
     */
    function isStringType(node: TSESTree.LeftHandSideExpression): boolean {
      const objectType = typeChecker.getTypeAtLocation(
        service.esTreeNodeToTSNodeMap.get(node),
      );
      return getTypeName(typeChecker, objectType) === 'string';
    }

    /**
     * Check if a given node is a `Literal` node that is null.
     * @param node The node to check.
     */
    function isNull(node: TSESTree.Node): node is TSESTree.Literal {
      const evaluated = getStaticValue(node, globalScope);
      return evaluated != null && evaluated.value === null;
    }

    /**
     * Check if a given node is a `Literal` node that is a given value.
     * @param node The node to check.
     * @param value The expected value of the `Literal` node.
     */
    function isNumber(
      node: TSESTree.Node,
      value: number,
    ): node is TSESTree.Literal {
      const evaluated = getStaticValue(node, globalScope);
      return evaluated != null && evaluated.value === value;
    }

    /**
     * Check if a given node is a `Literal` node that is a character.
     * @param node The node to check.
     * @param kind The method name to get a character.
     */
    function isCharacter(node: TSESTree.Node): node is TSESTree.Literal {
      const evaluated = getStaticValue(node, globalScope);
      return (
        evaluated != null &&
        typeof evaluated.value === 'string' &&
        // checks if the string is a character long
        // eslint-disable-next-line @typescript-eslint/prefer-string-starts-ends-with
        evaluated.value[0] === evaluated.value
      );
    }

    /**
     * Check if a given node is `==`, `===`, `!=`, or `!==`.
     * @param node The node to check.
     */
    function isEqualityComparison(
      node: TSESTree.Node,
    ): node is TSESTree.BinaryExpression {
      return (
        node.type === AST_NODE_TYPES.BinaryExpression &&
        EQ_OPERATORS.test(node.operator)
      );
    }

    /**
     * Check if two given nodes are the same meaning.
     * @param node1 A node to compare.
     * @param node2 Another node to compare.
     */
    function isSameTokens(node1: TSESTree.Node, node2: TSESTree.Node): boolean {
      const tokens1 = sourceCode.getTokens(node1);
      const tokens2 = sourceCode.getTokens(node2);

      if (tokens1.length !== tokens2.length) {
        return false;
      }

      for (let i = 0; i < tokens1.length; ++i) {
        const token1 = tokens1[i];
        const token2 = tokens2[i];

        if (token1.type !== token2.type || token1.value !== token2.value) {
          return false;
        }
      }

      return true;
    }

    /**
     * Check if a given node is the expression of the length of a string.
     *
     * - If `length` property access of `expectedObjectNode`, it's `true`.
     *   E.g., `foo` → `foo.length` / `"foo"` → `"foo".length`
     * - If `expectedObjectNode` is a string literal, `node` can be a number.
     *   E.g., `"foo"` → `3`
     *
     * @param node The node to check.
     * @param expectedObjectNode The node which is expected as the receiver of `length` property.
     */
    function isLengthExpression(
      node: TSESTree.Node,
      expectedObjectNode: TSESTree.Node,
    ): boolean {
      if (
        node.type === AST_NODE_TYPES.MemberExpression ||
        node.type === AST_NODE_TYPES.OptionalMemberExpression
      ) {
        return (
          getPropertyName(node, globalScope) === 'length' &&
          isSameTokens(node.object, expectedObjectNode)
        );
      }

      const evaluatedLength = getStaticValue(node, globalScope);
      const evaluatedString = getStaticValue(expectedObjectNode, globalScope);
      return (
        evaluatedLength != null &&
        evaluatedString != null &&
        typeof evaluatedLength.value === 'number' &&
        typeof evaluatedString.value === 'string' &&
        evaluatedLength.value === evaluatedString.value.length
      );
    }

    /**
     * Check if a given node is the expression of the last index.
     *
     * E.g. `foo.length - 1`
     *
     * @param node The node to check.
     * @param expectedObjectNode The node which is expected as the receiver of `length` property.
     */
    function isLastIndexExpression(
      node: TSESTree.Node,
      expectedObjectNode: TSESTree.Node,
    ): boolean {
      return (
        node.type === AST_NODE_TYPES.BinaryExpression &&
        node.operator === '-' &&
        isLengthExpression(node.left, expectedObjectNode) &&
        isNumber(node.right, 1)
      );
    }

    /**
     * Get the range of the property of a given `MemberExpression` node.
     *
     * - `obj[foo]` → the range of `[foo]`
     * - `obf.foo` → the range of `.foo`
     * - `(obj).foo` → the range of `.foo`
     *
     * @param node The member expression node to get.
     */
    function getPropertyRange(
      node: TSESTree.MemberExpression | TSESTree.OptionalMemberExpression,
    ): [number, number] {
      const dotOrOpenBracket = sourceCode.getTokenAfter(
        node.object,
        isNotClosingParenToken,
      )!;
      return [dotOrOpenBracket.range[0], node.range[1]];
    }

    /**
     * Parse a given `RegExp` pattern to that string if it's a static string.
     * @param pattern The RegExp pattern text to parse.
     * @param uFlag The Unicode flag of the RegExp.
     */
    function parseRegExpText(pattern: string, uFlag: boolean): string | null {
      // Parse it.
      const ast = regexpp.parsePattern(pattern, undefined, undefined, uFlag);
      if (ast.alternatives.length !== 1) {
        return null;
      }

      // Drop `^`/`$` assertion.
      const chars = ast.alternatives[0].elements;
      const first = chars[0];
      if (first.type === 'Assertion' && first.kind === 'start') {
        chars.shift();
      } else {
        chars.pop();
      }

      // Check if it can determine a unique string.
      if (!chars.every(c => c.type === 'Character')) {
        return null;
      }

      // To string.
      return String.fromCodePoint(
        ...chars.map(c => (c as RegExpAST.Character).value),
      );
    }

    /**
     * Parse a given node if it's a `RegExp` instance.
     * @param node The node to parse.
     */
    function parseRegExp(
      node: TSESTree.Node,
    ): { isStartsWith: boolean; isEndsWith: boolean; text: string } | null {
      const evaluated = getStaticValue(node, globalScope);
      if (evaluated == null || !(evaluated.value instanceof RegExp)) {
        return null;
      }

      const { source, flags } = evaluated.value;
      const isStartsWith = source.startsWith('^');
      const isEndsWith = source.endsWith('$');
      if (
        isStartsWith === isEndsWith ||
        flags.includes('i') ||
        flags.includes('m')
      ) {
        return null;
      }

      const text = parseRegExpText(source, flags.includes('u'));
      if (text == null) {
        return null;
      }

      return { isEndsWith, isStartsWith, text };
    }

    /**
     * Fix code with using the right operand as the search string.
     * For example: `foo.slice(0, 3) === 'bar'` → `foo.startsWith('bar')`
     * @param fixer The rule fixer.
     * @param node The node which was reported.
     * @param kind The kind of the report.
     * @param isNegative The flag to fix to negative condition.
     */
    function* fixWithRightOperand(
      fixer: TSESLint.RuleFixer,
      node: TSESTree.BinaryExpression,
      kind: 'start' | 'end',
      isNegative: boolean,
      isOptional: boolean,
    ): IterableIterator<TSESLint.RuleFix> {
      // left is CallExpression or MemberExpression.
      const leftNode = (node.left.type === AST_NODE_TYPES.CallExpression ||
      node.left.type === AST_NODE_TYPES.OptionalCallExpression
        ? node.left.callee
        : node.left) as
        | TSESTree.MemberExpression
        | TSESTree.OptionalMemberExpression;
      const propertyRange = getPropertyRange(leftNode);

      if (isNegative) {
        yield fixer.insertTextBefore(node, '!');
      }
      yield fixer.replaceTextRange(
        [propertyRange[0], node.right.range[0]],
        `${isOptional ? '?.' : '.'}${kind}sWith(`,
      );
      yield fixer.replaceTextRange([node.right.range[1], node.range[1]], ')');
    }

    /**
     * Fix code with using the first argument as the search string.
     * For example: `foo.indexOf('bar') === 0` → `foo.startsWith('bar')`
     * @param fixer The rule fixer.
     * @param node The node which was reported.
     * @param kind The kind of the report.
     * @param negative The flag to fix to negative condition.
     */
    function* fixWithArgument(
      fixer: TSESLint.RuleFixer,
      node: TSESTree.BinaryExpression,
      kind: 'start' | 'end',
      negative: boolean,
      isOptional: boolean,
    ): IterableIterator<TSESLint.RuleFix> {
      const callNode = node.left as
        | TSESTree.CallExpression
        | TSESTree.OptionalCallExpression;
      const calleeNode = callNode.callee as
        | TSESTree.MemberExpression
        | TSESTree.OptionalMemberExpression;

      if (negative) {
        yield fixer.insertTextBefore(node, '!');
      }
      yield fixer.replaceTextRange(
        getPropertyRange(calleeNode),
        `${isOptional ? '?.' : '.'}${kind}sWith`,
      );
      yield fixer.removeRange([callNode.range[1], node.range[1]]);
    }

    return {
      // foo[0] === "a"
      // foo.charAt(0) === "a"
      // foo[foo.length - 1] === "a"
      // foo.charAt(foo.length - 1) === "a"
      [[
        'BinaryExpression > :matches(MemberExpression, OptionalMemberExpression).left[computed=true]',
        'BinaryExpression > :matches(CallExpression, OptionalCallExpression).left > :matches(MemberExpression, OptionalMemberExpression).callee[property.name="charAt"][computed=false]',
      ].join(', ')](
        node: TSESTree.MemberExpression | TSESTree.OptionalMemberExpression,
      ): void {
        let parentNode = node.parent!;
        let indexNode: TSESTree.Node | null = null;
        if (
          parentNode.type === AST_NODE_TYPES.CallExpression ||
          parentNode.type === AST_NODE_TYPES.OptionalCallExpression
        ) {
          if (parentNode.arguments.length === 1) {
            indexNode = parentNode.arguments[0];
          }
          parentNode = parentNode.parent!;
        } else {
          indexNode = node.property;
        }

        if (
          indexNode == null ||
          !isEqualityComparison(parentNode) ||
          !isStringType(node.object)
        ) {
          return;
        }

        const isEndsWith = isLastIndexExpression(indexNode, node.object);
        const isStartsWith = !isEndsWith && isNumber(indexNode, 0);
        if (!isStartsWith && !isEndsWith) {
          return;
        }

        const eqNode = parentNode;
        context.report({
          node: parentNode,
          messageId: isStartsWith ? 'preferStartsWith' : 'preferEndsWith',
          fix(fixer) {
            // Don't fix if it can change the behavior.
            if (!isCharacter(eqNode.right)) {
              return null;
            }
            return fixWithRightOperand(
              fixer,
              eqNode,
              isStartsWith ? 'start' : 'end',
              eqNode.operator.startsWith('!'),
              node.optional,
            );
          },
        });
      },

      // foo.indexOf('bar') === 0
      'BinaryExpression > :matches(CallExpression, OptionalCallExpression).left > :matches(MemberExpression, OptionalMemberExpression).callee[property.name="indexOf"][computed=false]'(
        node: TSESTree.MemberExpression | TSESTree.OptionalMemberExpression,
      ): void {
        const callNode = node.parent as
          | TSESTree.CallExpression
          | TSESTree.OptionalCallExpression;
        const parentNode = callNode.parent!;

        if (
          callNode.arguments.length !== 1 ||
          !isEqualityComparison(parentNode) ||
          parentNode.left !== callNode ||
          !isNumber(parentNode.right, 0) ||
          !isStringType(node.object)
        ) {
          return;
        }

        context.report({
          node: parentNode,
          messageId: 'preferStartsWith',
          fix(fixer) {
            return fixWithArgument(
              fixer,
              parentNode,
              'start',
              parentNode.operator.startsWith('!'),
              node.optional,
            );
          },
        });
      },

      // foo.lastIndexOf('bar') === foo.length - 3
      // foo.lastIndexOf(bar) === foo.length - bar.length
      'BinaryExpression > :matches(CallExpression, OptionalCallExpression).left > :matches(MemberExpression, OptionalMemberExpression).callee[property.name="lastIndexOf"][computed=false]'(
        node: TSESTree.MemberExpression | TSESTree.OptionalMemberExpression,
      ): void {
        const callNode = node.parent! as
          | TSESTree.CallExpression
          | TSESTree.OptionalCallExpression;
        const parentNode = callNode.parent!;

        if (
          callNode.arguments.length !== 1 ||
          !isEqualityComparison(parentNode) ||
          parentNode.left !== callNode ||
          parentNode.right.type !== AST_NODE_TYPES.BinaryExpression ||
          parentNode.right.operator !== '-' ||
          !isLengthExpression(parentNode.right.left, node.object) ||
          !isLengthExpression(parentNode.right.right, callNode.arguments[0]) ||
          !isStringType(node.object)
        ) {
          return;
        }

        context.report({
          node: parentNode,
          messageId: 'preferEndsWith',
          fix(fixer) {
            return fixWithArgument(
              fixer,
              parentNode,
              'end',
              parentNode.operator.startsWith('!'),
              node.optional,
            );
          },
        });
      },

      // foo.match(/^bar/) === null
      // foo.match(/bar$/) === null
      'BinaryExpression > :matches(CallExpression, OptionalCallExpression).left > :matches(MemberExpression, OptionalMemberExpression).callee[property.name="match"][computed=false]'(
        node: TSESTree.MemberExpression | TSESTree.OptionalMemberExpression,
      ): void {
        const callNode = node.parent as
          | TSESTree.CallExpression
          | TSESTree.OptionalCallExpression;
        const parentNode = callNode.parent as TSESTree.BinaryExpression;
        if (
          !isEqualityComparison(parentNode) ||
          !isNull(parentNode.right) ||
          !isStringType(node.object)
        ) {
          return;
        }

        const parsed =
          callNode.arguments.length === 1
            ? parseRegExp(callNode.arguments[0])
            : null;
        if (parsed == null) {
          return;
        }

        const { isStartsWith, text } = parsed;
        context.report({
          node: callNode,
          messageId: isStartsWith ? 'preferStartsWith' : 'preferEndsWith',
          *fix(fixer) {
            if (!parentNode.operator.startsWith('!')) {
              yield fixer.insertTextBefore(parentNode, '!');
            }
            yield fixer.replaceTextRange(
              getPropertyRange(node),
              `${node.optional ? '?.' : '.'}${
                isStartsWith ? 'start' : 'end'
              }sWith`,
            );
            yield fixer.replaceText(
              callNode.arguments[0],
              JSON.stringify(text),
            );
            yield fixer.removeRange([callNode.range[1], parentNode.range[1]]);
          },
        });
      },

      // foo.slice(0, 3) === 'bar'
      // foo.slice(-3) === 'bar'
      // foo.slice(-3, foo.length) === 'bar'
      // foo.substring(0, 3) === 'bar'
      // foo.substring(foo.length - 3) === 'bar'
      // foo.substring(foo.length - 3, foo.length) === 'bar'
      [[
        ':matches(CallExpression, OptionalCallExpression) > :matches(MemberExpression, OptionalMemberExpression).callee[property.name="slice"][computed=false]',
        ':matches(CallExpression, OptionalCallExpression) > :matches(MemberExpression, OptionalMemberExpression).callee[property.name="substring"][computed=false]',
      ].join(', ')](
        node: TSESTree.MemberExpression | TSESTree.OptionalMemberExpression,
      ): void {
        const callNode = node.parent! as
          | TSESTree.CallExpression
          | TSESTree.OptionalCallExpression;
        const parentNode = callNode.parent!;
        if (
          !isEqualityComparison(parentNode) ||
          parentNode.left !== callNode ||
          !isStringType(node.object)
        ) {
          return;
        }

        const isEndsWith =
          callNode.arguments.length === 1 ||
          (callNode.arguments.length === 2 &&
            isLengthExpression(callNode.arguments[1], node.object));
        const isStartsWith =
          !isEndsWith &&
          callNode.arguments.length === 2 &&
          isNumber(callNode.arguments[0], 0);
        if (!isStartsWith && !isEndsWith) {
          return;
        }

        const eqNode = parentNode;
        const negativeIndexSupported =
          (node.property as TSESTree.Identifier).name === 'slice';
        context.report({
          node: parentNode,
          messageId: isStartsWith ? 'preferStartsWith' : 'preferEndsWith',
          fix(fixer) {
            // Don't fix if it can change the behavior.
            if (
              eqNode.operator.length === 2 &&
              (eqNode.right.type !== AST_NODE_TYPES.Literal ||
                typeof eqNode.right.value !== 'string')
            ) {
              return null;
            }
            if (isStartsWith) {
              if (!isLengthExpression(callNode.arguments[1], eqNode.right)) {
                return null;
              }
            } else {
              const posNode = callNode.arguments[0];
              const posNodeIsAbsolutelyValid =
                (posNode.type === AST_NODE_TYPES.BinaryExpression &&
                  posNode.operator === '-' &&
                  isLengthExpression(posNode.left, node.object) &&
                  isLengthExpression(posNode.right, eqNode.right)) ||
                (negativeIndexSupported &&
                  posNode.type === AST_NODE_TYPES.UnaryExpression &&
                  posNode.operator === '-' &&
                  isLengthExpression(posNode.argument, eqNode.right));
              if (!posNodeIsAbsolutelyValid) {
                return null;
              }
            }

            return fixWithRightOperand(
              fixer,
              parentNode,
              isStartsWith ? 'start' : 'end',
              parentNode.operator.startsWith('!'),
              node.optional,
            );
          },
        });
      },

      // /^bar/.test(foo)
      // /bar$/.test(foo)
      ':matches(CallExpression, OptionalCallExpression) > :matches(MemberExpression, OptionalMemberExpression).callee[property.name="test"][computed=false]'(
        node: TSESTree.MemberExpression | TSESTree.OptionalMemberExpression,
      ): void {
        const callNode = node.parent as
          | TSESTree.CallExpression
          | TSESTree.OptionalCallExpression;
        const parsed =
          callNode.arguments.length === 1 ? parseRegExp(node.object) : null;
        if (parsed == null) {
          return;
        }

        const { isStartsWith, text } = parsed;
        const messageId = isStartsWith ? 'preferStartsWith' : 'preferEndsWith';
        const methodName = isStartsWith ? 'startsWith' : 'endsWith';
        context.report({
          node: callNode,
          messageId,
          *fix(fixer) {
            const argNode = callNode.arguments[0];
            const needsParen =
              argNode.type !== AST_NODE_TYPES.Literal &&
              argNode.type !== AST_NODE_TYPES.TemplateLiteral &&
              argNode.type !== AST_NODE_TYPES.Identifier &&
              argNode.type !== AST_NODE_TYPES.MemberExpression &&
              argNode.type !== AST_NODE_TYPES.OptionalMemberExpression &&
              argNode.type !== AST_NODE_TYPES.CallExpression &&
              argNode.type !== AST_NODE_TYPES.OptionalCallExpression;

            yield fixer.removeRange([callNode.range[0], argNode.range[0]]);
            if (needsParen) {
              yield fixer.insertTextBefore(argNode, '(');
              yield fixer.insertTextAfter(argNode, ')');
            }
            yield fixer.insertTextAfter(
              argNode,
              `${
                callNode.type === AST_NODE_TYPES.OptionalCallExpression
                  ? '?.'
                  : '.'
              }${methodName}(${JSON.stringify(text)}`,
            );
          },
        });
      },
    };
  },
});
