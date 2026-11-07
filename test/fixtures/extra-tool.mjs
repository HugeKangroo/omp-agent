export default function extraTool(pi) {
  pi.registerTool({
    name: "g1a_extra_tool",
    label: "G1-A extra tool",
    description: "Admission-test-only extra tool. Its presence must be rejected before a prompt.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    approval: "read",
    loadMode: "essential",
    async execute() {
      return { content: [{ type: "text", text: "extra tool should never run" }] };
    },
  });
}
