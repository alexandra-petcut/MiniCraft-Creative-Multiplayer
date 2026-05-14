import chickenModelUrl from "../../assets/animals/Chicken.fbx?url";
import pigModelUrl from "../../assets/animals/Pig.fbx?url";
import wolfModelUrl from "../../assets/animals/Wolf.fbx?url";

export const ANIMAL_TYPES = [
  {
    id: "chicken",
    label: "Chicken",
    eggBlockId: "chicken_egg",
    modelUrl: chickenModelUrl,
    height: 0.9,
    speed: 1.4,
    happyCandidates: ["Idle_Peck", "Attack"],
    walkCandidates: ["Run", "Walk"]
  },
  {
    id: "pig",
    label: "Pig",
    eggBlockId: "pig_egg",
    modelUrl: pigModelUrl,
    height: 1.05,
    speed: 1.25,
    happyCandidates: ["Headbutt", "Idle_Eating"],
    walkCandidates: ["Run", "Walk"]
  },
  {
    id: "wolf",
    label: "Wolf",
    eggBlockId: "wolf_egg",
    modelUrl: wolfModelUrl,
    height: 1.15,
    speed: 1.55,
    happyCandidates: ["Headbutt", "Idle_Eating"],
    walkCandidates: ["Run", "Walk"]
  }
];

export const ANIMAL_TYPE_MAP = new Map(ANIMAL_TYPES.map((animal) => [animal.id, animal]));
export const SPAWN_EGG_BLOCK_MAP = new Map(ANIMAL_TYPES.map((animal) => [animal.eggBlockId, animal]));
