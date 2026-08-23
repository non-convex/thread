import { Type } from "@earendil-works/pi-ai";

export default function activate(api) {
  api.registerTool({
    name: "echo_local",
    description: "Return text from a local example extension.",
    parameters: Type.Object({ text: Type.String() }),
    replay: "safe",
    async execute(args) {
      return { content: args.text, isError: false };
    },
  });

  api.registerCommand({
    name: "hello",
    description: "Demonstrate extension command registration.",
    async execute() {
      return { content: "hello from the example extension", presentation: "ephemeral", changedState: false };
    },
  });
}
