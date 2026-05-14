const PUBLIC_BLOCK_TYPES = [
  "grass",
  "dirt",
  "stone",
  "wood",
  "glass",
  "red",
  "blue",
  "yellow",
  "white"
];

const STORAGE_BLOCK_TYPES = [...PUBLIC_BLOCK_TYPES, "air"];

module.exports = {
  PUBLIC_BLOCK_TYPES,
  STORAGE_BLOCK_TYPES
};

