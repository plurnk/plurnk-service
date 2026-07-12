import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runConformance } from "./harness.ts";

const SOURCE = `#include <vector>
using std::vector;
using namespace std;

namespace geo {

class Shape {
public:
    virtual double area();
    int sides;
};

class Circle : public Shape, private util::Tagged {
public:
    double radius;
    double area() {
        return compute(radius);
    }
    Shape* duplicate() {
        Shape* copy = new Circle();
        copy->resize();
        return copy;
    }
};

double compute(double r, vector<double> samples) {
    return helper::square(r);
}

}

int main() {
    geo::Circle c;
    double a = c.area();
    Box b = Box{};
    return 0;
}

const char* DECOY = "StringDecoy() should never surface";
// CommentDecoy() should never surface
`;

describe("conformance: text/x-cpp defs + refs (issues #19/#20)", () => {
    it("passes the shared invariants and expected captures", async () => {
        const { references } = await runConformance({
            mimetype: "text/x-cpp",
            source: SOURCE,
            decoyNames: ["StringDecoy", "CommentDecoy"],
            expectJoins: [
                // compute called from Circle::area joins to the namespace-level
                // function — the cpp mapping emits namespace containers, so
                // method scopes are geo.Circle.<method>.
                { refName: "compute", container: "geo.Circle.area" },
                { refName: "Circle", container: "geo.Circle.duplicate" },
                { refName: "Shape", container: "geo.Circle.duplicate" },
                { refName: "area", container: "main" },
            ],
            expectRefs: [
                // `using std::vector` captures the bound final identifier.
                { name: "vector", kind: "import", line: 2 },
                // Base-class refs sit on the class's own def line, so their
                // container is the class itself (innermost enclosing def).
                { name: "Shape", kind: "inherit", line: 13, container: "geo.Circle" },
                // Qualified base captures the final segment only.
                { name: "Tagged", kind: "inherit", line: 13, container: "geo.Circle" },
                { name: "compute", kind: "call", line: 17, container: "geo.Circle.area" },
                // Return type of duplicate().
                { name: "Shape", kind: "type", line: 19, container: "geo.Circle.duplicate" },
                // Local declaration type.
                { name: "Shape", kind: "type", line: 20, container: "geo.Circle.duplicate" },
                { name: "Circle", kind: "instantiate", line: 20, container: "geo.Circle.duplicate" },
                // Arrow-call method name.
                { name: "resize", kind: "call", line: 21, container: "geo.Circle.duplicate" },
                // Template head in a parameter type; arguments stay out.
                { name: "vector", kind: "type", line: 26, container: "geo.compute" },
                // Qualified call captures the final segment.
                { name: "square", kind: "call", line: 27, container: "geo.compute" },
                // Qualified local type captures the final segment.
                { name: "Circle", kind: "type", line: 33, container: "main" },
                { name: "area", kind: "call", line: 34, container: "main" },
                { name: "Box", kind: "type", line: 35, container: "main" },
                // Compound-literal construction.
                { name: "Box", kind: "instantiate", line: 35, container: "main" },
            ],
        });
        // Scope qualifiers and `using namespace` never surface — only final
        // segments and bound names.
        for (const scope of ["std", "geo", "util", "helper"]) {
            assert.ok(
                !references.some((r) => r.name === scope),
                `scope qualifier "${scope}" surfaced as a ref`,
            );
        }
        // No bare identifier reads.
        for (const bare of ["copy", "radius", "r", "c", "a", "b"]) {
            assert.ok(
                !references.some((r) => r.name === bare),
                `bare identifier read "${bare}" surfaced as a ref`,
            );
        }
    });
});
