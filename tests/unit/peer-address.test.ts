import assert from "node:assert/strict";
import http from "node:http";
import { describe, test } from "node:test";
import {
  getPeerAddress,
  installPeerAddressCapture,
  runWithPeerAddress,
} from "@/src/api/peer-address";

describe("transport peer capture", () => {
  test("runWithPeerAddress scopes the captured peer", () => {
    assert.equal(getPeerAddress(), null);
    const result = runWithPeerAddress("203.0.113.9", () => getPeerAddress());
    assert.equal(result, "203.0.113.9");
    assert.equal(getPeerAddress(), null);
  });

  test("captures socket.remoteAddress, not a client-supplied forwarding header", async () => {
    installPeerAddressCapture();
    installPeerAddressCapture(); // idempotent

    await new Promise<void>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            peer: getPeerAddress(),
            xff: req.headers["x-forwarded-for"] ?? null,
          })
        );
      });

      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          server.close(() => reject(new Error("expected a TCP address")));
          return;
        }

        http.get(
          {
            hostname: "127.0.0.1",
            port: address.port,
            path: "/",
            headers: { "x-forwarded-for": "1.2.3.4" },
            agent: false,
          },
          (res) => {
            let body = "";
            res.on("data", (chunk) => {
              body += chunk;
            });
            res.on("end", () => {
              try {
                assert.equal(res.statusCode, 200);
                assert.deepEqual(JSON.parse(body), {
                  peer: "127.0.0.1",
                  xff: "1.2.3.4",
                });
                server.close(() => resolve());
              } catch (error) {
                server.close(() => reject(error));
              }
            });
          }
        ).on("error", (error) => {
          server.close(() => reject(error));
        });
      });
    });
  });
});
