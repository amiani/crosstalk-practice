import { describe, expect, it } from "vitest";

import { coolingTargets } from "./Curriculum.ts";

describe("coolingTargets", () => {
  it("cools targets whose latest recent plan failed", () => {
    expect(
      coolingTargets([
        { status: "failed", targetId: "a" },
        { status: "written", targetId: "b" },
        { status: "pending", targetId: "c" },
        { status: "failed", targetId: "b" },
        { status: "written", targetId: "a" },
      ]),
    ).toEqual(new Set(["a"]));
  });
});
