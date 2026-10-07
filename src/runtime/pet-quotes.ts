// What the pet says. The random lines are a selection of zcode-fox-widget's fox quote pack
// (QUOTE_PACK_FOX) with its weights, without the group that showed spending; the mood lines are
// Canvas's own.
import type { PetMood } from "../shared/pet-state.ts";

/** "A": regular size, wraps; "B": large, one line. Mirrors the fox widget's two type sizes. */
export type PetLine = { text: string; size: "A" | "B" };

const PICK = ["好模型... ↓", "好女孩...↓"];
const QUOTES = ["你也要一份免费鸡蛋吗", "我去睡觉啦，测完叫我", "压力一只黑色小狐娘？！", "Zzzzzzz...", "token要逃走了！"];
const TAIL = ["恭喜你实现token自由！token全跑了！", "真当我是便宜货啊..."];
const OHH = "哦鲸鲸... ";

const pickOne = (lines: readonly string[], random: () => number) => lines[Math.floor(random() * lines.length)] ?? lines[0]!;

const GROUPS: ReadonlyArray<{ weight: number; line: (random: () => number) => PetLine }> = [
  { weight: 7, line: (random) => ({ text: pickOne(PICK, random), size: "B" }) },
  { weight: 10, line: (random) => ({ text: pickOne(QUOTES, random), size: "A" }) },
  { weight: 5, line: (random) => ({ text: pickOne(TAIL, random), size: "A" }) },
  { weight: 1, line: () => ({ text: OHH, size: "B" }) },
];

export function randomLine(random: () => number = Math.random): PetLine {
  const total = GROUPS.reduce((sum, group) => sum + group.weight, 0);
  let roll = random() * total;
  for (const group of GROUPS) {
    roll -= group.weight;
    if (roll < 0) return group.line(random);
  }
  return GROUPS[0]!.line(random);
}

const MOOD_LINES: Partial<Record<PetMood, readonly string[]>> = {
  waiting: ["主人，该你了！", "有个问题要问你哦~", "等你点头呢..."],
  done: ["搞定啦！快来验收~", "做完了！夸我！", "好了好了，测完叫我"],
  error: ["呜...出错了...", "坏了...好像搞砸了", "不、不是我干的！"],
};

/** The line announcing a mood, or null for moods the pet only shows, never says. */
export function moodLine(mood: PetMood, random: () => number = Math.random): PetLine | null {
  const lines = MOOD_LINES[mood];
  return lines ? { text: pickOne(lines, random), size: "A" } : null;
}
