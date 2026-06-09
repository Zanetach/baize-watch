import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFocusedInputProbeScript,
  isFocusedTextInput,
  parseFocusedInputProbe
} from "./focused-input.js";

test("focused input probe parser reads front app and focused element metadata", () => {
  assert.deepEqual(parseFocusedInputProbe("WeChat|||AXTextArea||||||text area\n"), {
    app: "WeChat",
    role: "AXTextArea",
    subrole: "",
    description: "text area"
  });
});

test("focused input detection accepts text fields and rejects non-editable controls", () => {
  assert.equal(isFocusedTextInput({ role: "AXTextArea" }), true);
  assert.equal(isFocusedTextInput({ role: "AXTextField" }), true);
  assert.equal(isFocusedTextInput({ role: "AXGroup", description: "输入文本" }), true);
  assert.equal(isFocusedTextInput({ role: "AXButton", description: "button" }), false);
  assert.equal(isFocusedTextInput({ role: "", description: "" }), false);
});

test("focused input detection treats frontmost chat apps as dictation targets when AX focus is empty", () => {
  assert.equal(isFocusedTextInput({ app: "Codex", role: "", description: "" }), true);
  assert.equal(isFocusedTextInput({ app: "WeChat", role: "", description: "" }), true);
  assert.equal(isFocusedTextInput({ app: "Feishu", role: "", description: "" }), true);
  assert.equal(isFocusedTextInput({ app: "Finder", role: "", description: "" }), false);
});

test("focused input probe script asks System Events for the frontmost focused UI element", () => {
  const script = buildFocusedInputProbeScript().join("\n");

  assert.match(script, /System Events/);
  assert.match(script, /frontmost is true/);
  assert.match(script, /AXFocusedUIElement/);
  assert.match(script, /AXRole/);
});
