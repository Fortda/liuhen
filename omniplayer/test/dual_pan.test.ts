import assert from "node:assert/strict";
import { test } from "node:test";
import {
  auxPanStep,
  isAuxPanButton,
  wantAuxPanFromButtons,
} from "../src/notes_clue_dual_pan.ts";

test("aux pan accepts right or middle, not left", () => {
  assert.equal(isAuxPanButton(2), true);
  assert.equal(isAuxPanButton(1), true);
  assert.equal(isAuxPanButton(0), false);
  assert.equal(isAuxPanButton(3), false);
});

test("buttons bitmap starts pan for right or middle while left is held", () => {
  assert.equal(wantAuxPanFromButtons(1), false);
  assert.equal(wantAuxPanFromButtons(1 | 2), true);
  assert.equal(wantAuxPanFromButtons(1 | 4), true);
  assert.equal(wantAuxPanFromButtons(2), true);
  assert.equal(wantAuxPanFromButtons(0), false);
});

test("aux pan step is the pointer delta and advances the last point", () => {
  assert.deepEqual(auxPanStep(10, 20, 14, 17), {
    nextX: 14,
    nextY: 17,
    dpx: 4,
    dpy: -3,
  });
});
