// @ts-check
import {
  isArbitraryColor,
  isArbitraryFontSize,
  isNeutral,
  parseClass,
  splitClasses,
} from "./tailwind-classes.js";

/** Parent node types whose string `source` is a module specifier, not a class list. */
const MODULE_SOURCE_PARENTS = new Set([
  "ImportDeclaration",
  "ExportAllDeclaration",
  "ExportNamedDeclaration",
]);

/** @type {import("eslint").Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Forbid raw neutral palette classes, `dark:` colour overrides, and arbitrary colour / font-size values in class strings. Use the semantic design tokens instead.",
    },
    messages: {
      neutral:
        "Raw neutral palette class `{{cls}}` — use a semantic token (bg-canvas/sunken/raised/overlay/hover, text-fg*, border-edge*).",
      darkColor:
        "`{{cls}}`: `dark:` colour overrides are unnecessary — tokens switch with the theme.",
      arbitraryColor: "Arbitrary colour `{{cls}}` — add a token instead.",
      arbitraryFontSize:
        "Arbitrary font size `{{cls}}` — use text-2xs or the Tailwind type scale.",
    },
    schema: [],
  },
  create(context) {
    /**
     * Check every whitespace-separated token of `text` and report each
     * category it matches (a single token can match several).
     * @param {import("estree").Node} node
     * @param {string} text
     */
    function check(node, text) {
      for (const cls of splitClasses(text)) {
        const parsed = parseClass(cls);
        if (parsed && isNeutral(parsed)) {
          context.report({ node, messageId: "neutral", data: { cls } });
        }
        if (parsed && parsed.variants.includes("dark")) {
          context.report({ node, messageId: "darkColor", data: { cls } });
        }
        if (isArbitraryColor(cls)) {
          context.report({ node, messageId: "arbitraryColor", data: { cls } });
        }
        if (isArbitraryFontSize(cls)) {
          context.report({
            node,
            messageId: "arbitraryFontSize",
            data: { cls },
          });
        }
      }
    }

    return {
      Literal(node) {
        if (typeof node.value !== "string") return;
        const parent = /** @type {import("estree").Node | undefined} */ (
          /** @type {any} */ (node).parent
        );
        if (parent && MODULE_SOURCE_PARENTS.has(parent.type)) return;
        check(node, node.value);
      },
      TemplateElement(node) {
        const cooked = node.value.cooked;
        if (typeof cooked !== "string") return;
        check(node, cooked);
      },
    };
  },
};
