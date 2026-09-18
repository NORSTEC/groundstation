import { describe, expect, it } from "vitest";
import { classifyMemberStatuses } from "@/lib/statistics";

describe("classifyMemberStatuses", () => {
  it("includes alumni access granted without a membership", () => {
    const result = classifyMemberStatuses(
      [
        { personId: 1, status: "active" },
        { personId: 2, status: "ended" },
      ],
      [3],
    );

    expect([...result.activeMemberIds]).toEqual([1]);
    expect([...result.alumniMemberIds]).toEqual([2, 3]);
    expect([...result.allMemberIds]).toEqual([1, 2, 3]);
  });

  it("counts a person with an active membership as active only", () => {
    const result = classifyMemberStatuses(
      [
        { personId: 1, status: "ended" },
        { personId: 1, status: "active" },
      ],
      [1],
    );

    expect([...result.activeMemberIds]).toEqual([1]);
    expect([...result.alumniMemberIds]).toEqual([]);
    expect([...result.allMemberIds]).toEqual([1]);
  });

  it("does not count duplicate memberships or alumni grants twice", () => {
    const result = classifyMemberStatuses(
      [
        { personId: 4, status: "ended" },
        { personId: 4, status: "ended" },
      ],
      [4, 4],
    );

    expect(result.alumniMemberIds.size).toBe(1);
    expect(result.allMemberIds.size).toBe(1);
  });
});
