export const BLOCK_TYPES = [
  { id: "grass", label: "Grass", color: "#48a23f" },
  { id: "dirt", label: "Dirt", color: "#7a4b2b" },
  { id: "stone", label: "Stone", color: "#8c9399" },
  { id: "wood", label: "Wood", color: "#9f6a38" },
  { id: "glass", label: "Glass", color: "#8fd8ff", transparent: true },
  { id: "red", label: "Red", color: "#d63f3f" },
  { id: "blue", label: "Blue", color: "#356bd8" },
  { id: "yellow", label: "Yellow", color: "#e2c440" },
  { id: "white", label: "White", color: "#f4f1e8" }
];

export const BLOCK_TYPE_MAP = new Map(BLOCK_TYPES.map((block) => [block.id, block]));

