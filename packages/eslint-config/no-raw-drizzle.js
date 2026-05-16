// @ts-check

/** @type {import("eslint").Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Forbid importing `drizzle-orm` outside `packages/db`. All DB access goes through `@furan/db`.",
    },
    messages: {
      banned:
        "Direct `drizzle-orm` import is forbidden outside `packages/db`. Import from `@furan/db` instead.",
    },
    schema: [],
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    // Allow inside packages/db (any depth).
    if (filename.includes("/packages/db/")) return {};
    return {
      ImportDeclaration(node) {
        const source = node.source.value;
        if (typeof source !== "string") return;
        if (source === "drizzle-orm" || source.startsWith("drizzle-orm/")) {
          context.report({ node, messageId: "banned" });
        }
      },
    };
  },
};
