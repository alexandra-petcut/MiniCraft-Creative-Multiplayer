import { BLOCK_TYPES } from "./blockTypes";

const SIDES = ["top", "bottom", "left", "right", "front", "back"];
const textureModules = import.meta.glob(
  [
    "../../assets/textures/*/*.png",
    "!../../assets/textures/_source/*.png",
    "!../../assets/textures/_unique/*.png"
  ],
  {
    eager: true,
    import: "default"
  }
);

function getTextureSet(blockId) {
  return Object.fromEntries(
    SIDES.map((side) => {
      const key = `../../assets/textures/${blockId}/${side}.png`;
      const texture = textureModules[key];

      if (!texture) {
        throw new Error(`Missing ${side} texture for block type "${blockId}"`);
      }

      return [side, texture];
    })
  );
}

export const BLOCK_TEXTURES = Object.fromEntries(
  BLOCK_TYPES.map((block) => [block.id, getTextureSet(block.id)])
);
