export const transformerFileName = ({ hideDot = false } = {}) => ({
  pre(node) {
    const raw = this.options.meta?.__raw?.split(" ");
    if (!raw) return;

    const metaMap = new Map();
    for (const item of raw) {
      const [key, value] = item.split("=");
      if (!key || !value) continue;
      metaMap.set(key, value.replace(/["'`]/g, ""));
    }

    const file = metaMap.get("file");
    if (!file) return;

    // Espacio arriba del bloque para que quepa el badge
    this.addClassToHast(node, "mt-8");

    // Badge con el nombre de archivo
    node.children.push({
      type: "element",
      tagName: "span",
      properties: {
        class: [
          "absolute py-1 text-skin-base text-xs font-medium leading-4",
          hideDot
            ? "px-2"
            : "pl-4 pr-2 before:inline-block before:size-1 before:bg-green-500 before:rounded-full before:absolute before:top-[45%] before:left-2",
          "left-2 -top-3 border border-skin-line rounded-md bg-skin-fill",
        ].join(" "),
      },
      children: [{ type: "text", value: file }],
    });
  },
});