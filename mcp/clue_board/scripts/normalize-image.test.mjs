/**
 * Image-ref normalize (no board file). Run after `npm run build` in mcp/clue_board.
 */
import { normalizeClueImageRef, normalizeClueNodesEdges } from "../dist/normalize.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(
  normalizeClueImageRef("clue_images/Ab_1.PNG") === "clue_images/Ab_1.png",
  "ext"
);
assert(normalizeClueImageRef("clue_images/../x.png") === undefined, "traversal");
assert(normalizeClueImageRef("data:image/png;base64,aaaa") === undefined, "data url");

const { nodes } = normalizeClueNodesEdges(
  [
    {
      id: "n1",
      text: "pic",
      x: 1,
      y: 2,
      image: "clue_images/pic.png",
    },
    {
      id: "n2",
      text: "bad",
      x: 0,
      y: 0,
      image: "C:/secret.png",
    },
  ],
  [],
);
assert(nodes[0].image === "clue_images/pic.png", "keeps ref");
assert(nodes[1].image === undefined, "strips unsafe image");
console.log("normalize image test OK");
