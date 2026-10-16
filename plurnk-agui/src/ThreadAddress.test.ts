import assert from "node:assert/strict";
import test from "node:test";
import ThreadAddress from "./ThreadAddress.ts";

test("{§agui-thread-address} qualified IDs use canonical positive integers and native worker names", () => {
    for (const name of ["alice", "9", "worker_name-1"]) {
        assert.deepEqual(ThreadAddress.parse(`42#${name}`), { workspaceId: 42, workerName: name });
    }
    for (const address of ["0#alice", "00#alice", "01#alice", "9007199254740992#alice", "42#_plurnk", "42#", "42#a/b", "42#one#two"]) {
        assert.throws(() => ThreadAddress.parse(address), /qualified thread address/u, address);
    }
});

test("{§agui-thread-address} other strings remain opaque rather than becoming workspace names", () => {
    for (const address of ["", "123", "thread", "customer/分析 #blue?100%", "~/project#alice", "/123#alice"]) {
        assert.equal(ThreadAddress.parse(address), null, address);
    }
});
