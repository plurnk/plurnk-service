import assert from "node:assert/strict";
import test from "node:test";
import HostPolicy, { HOSTS_ENV, HostPolicyError } from "./HostPolicy.ts";

const withPolicy = (value: string | undefined, run: () => void): void => {
    const prior = process.env[HOSTS_ENV];
    if (value === undefined) delete process.env[HOSTS_ENV]; else process.env[HOSTS_ENV] = value;
    try { run(); } finally { if (prior === undefined) delete process.env[HOSTS_ENV]; else process.env[HOSTS_ENV] = prior; }
};

test("{§http-host-policy} unset or empty admits every host", () => {
    for (const value of [undefined, "", "  "]) withPolicy(value, () => {
        assert.equal(HostPolicy.permits("https://raw.githubusercontent.com/a/b"), true);
    });
});

test("{§http-host-policy} [] admits no host; a list admits exact hosts and wildcard subdomains", () => {
    withPolicy("[]", () => {
        assert.equal(HostPolicy.permits("https://api.github.com/search/issues"), false);
        assert.throws(() => HostPolicy.require("https://api.github.com/x"), HostPolicyError);
    });
    withPolicy('["api.example.com", "*.docs.example.org"]', () => {
        assert.equal(HostPolicy.permits("https://api.example.com/v1"), true);
        assert.equal(HostPolicy.permits("https://API.EXAMPLE.COM/v1"), true);
        assert.equal(HostPolicy.permits("https://www.api.example.com/v1"), false);
        assert.equal(HostPolicy.permits("https://a.docs.example.org/x"), true);
        assert.equal(HostPolicy.permits("https://docs.example.org/x"), false);
        assert.equal(HostPolicy.permits("not a url"), false);
    });
});

test("{§http-host-policy} a malformed policy fails at first use", () => {
    for (const value of ["github.com", '[""]', '[1]', '{"hosts":[]}']) withPolicy(value, () => {
        assert.throws(() => HostPolicy.permits("https://github.com"), /must be a JSON array of host names/);
    });
});
