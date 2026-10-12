import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ParsedNode } from "@subboost/core/types/node";
import { SourceNodePositionInput } from "./source-node-position-input";

const node: ParsedNode = {
  name: "A1", type: "ss", server: "a1.example.test", port: 443, cipher: "aes-128-gcm", password: "test",
};

function controls(draft?: string, manualPosition?: number) {
  let drafts: Record<string, string> = draft === undefined ? {} : { A1: draft };
  const setNodeOrder = vi.fn();
  const tree = SourceNodePositionInput({
    node: { ...node, _manualPosition: manualPosition }, position: 2, nodeCount: 6,
    orderDrafts: drafts, setNodeOrder,
    setOrderDrafts: (update) => { drafts = typeof update === "function" ? update(drafts) : update; },
  });
  const elements = React.Children.toArray((tree.props as { children: React.ReactNode }).children)
    .filter(React.isValidElement) as React.ReactElement<Record<string, any>>[];
  return { tree, setNodeOrder, getDrafts: () => drafts,
    input: elements.find((element) => element.props["aria-label"] === "A1的指定位置")!,
    restore: elements.find((element) => element.props.label === "恢复继承"),
  };
}

describe("SourceNodePositionInput", () => {
  it("shows the actual position separately from the inherited or requested position", () => {
    const inherited = controls();
    expect(inherited.input.props.value).toBe("");
    expect(inherited.restore).toBeUndefined();
    expect(renderToStaticMarkup(inherited.tree)).toContain("第 2 位");
    const pinned = controls(undefined, 10);
    expect(pinned.input.props.value).toBe("10");
    expect(pinned.input.props.title).toContain("指定第 10 位，当前按可用位置排列");
  });

  it("commits a valid absolute position and clears the editing draft", () => {
    const control = controls(" 3 ");
    const preventDefault = vi.fn();
    control.input.props.onKeyDown({ key: "Enter", preventDefault });
    expect(control.setNodeOrder).toHaveBeenCalledWith("A1", 3);
    expect(preventDefault).toHaveBeenCalled();
    expect(control.getDrafts()).toEqual({});
  });

  it("clears a pin with a blank value or the restore button", () => {
    const blank = controls(" ", 3);
    blank.input.props.onBlur();
    expect(blank.setNodeOrder).toHaveBeenCalledWith("A1", null);
    const restore = controls(undefined, 3);
    restore.restore!.props.onClick();
    expect(restore.setNodeOrder).toHaveBeenCalledWith("A1", null);
  });

  it("rejects invalid positions without changing the pin or discarding the input", () => {
    for (const draft of ["0", "-1", "1.5", "2x", "7", "9007199254740992"]) {
      const control = controls(draft, 3);
      control.input.props.onBlur();
      expect(control.setNodeOrder).not.toHaveBeenCalled();
      expect(control.getDrafts()).toEqual({ A1: draft });
      expect(control.input.props["aria-invalid"]).toBe(true);
      expect(renderToStaticMarkup(control.tree)).toContain('role="alert"');
    }
  });

  it("cancels the draft on Escape and ignores an untouched input on blur", () => {
    const editing = controls("4", 3);
    editing.input.props.onKeyDown({ key: "Escape", preventDefault: vi.fn() });
    expect(editing.setNodeOrder).not.toHaveBeenCalled();
    expect(editing.getDrafts()).toEqual({});
    const untouched = controls(undefined, 3);
    untouched.input.props.onBlur();
    expect(untouched.setNodeOrder).not.toHaveBeenCalled();
  });
});
