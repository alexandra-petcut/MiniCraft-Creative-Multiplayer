const PUBLIC_BLOCK_TYPES = [
  "grass",
  "dirt",
  "stone",
  "wood",
  "glass",
  "red",
  "blue",
  "yellow",
  "white",
  "brick",
  "quartz",
  "red_clay",
  "blue_clay",
  "green_clay",
  "purple_clay",
  "orange_clay",
  "black_clay",
  "marble",
  "sandstone",
  "slate",
  "basalt",
  "copper",
  "ice",
  "chicken_egg",
  "pig_egg",
  "wolf_egg"
];

const STORAGE_BLOCK_TYPES = [...PUBLIC_BLOCK_TYPES, "air"];

module.exports = {
  PUBLIC_BLOCK_TYPES,
  STORAGE_BLOCK_TYPES
};
