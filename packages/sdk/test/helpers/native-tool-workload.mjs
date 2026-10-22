import childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

/** A real native HTTP request held open by the fixture, without a forbidden shell timer. */
export async function createNativeToolWorkload() {
    const marker = `pstc${randomUUID().replaceAll("-", "")}`;
    const pending = new Set();
    let firstRequest;
    const requested = new Promise(resolve => { firstRequest = resolve; });
    const server = createServer((request, response) => {
        if (request.method !== "GET" || request.url !== `/${marker}`) {
            response.writeHead(404);
            response.end("Unknown test workload");
            return;
        }
        pending.add(response);
        response.once("close", () => pending.delete(response));
        firstRequest();
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
        });
    });
    const url = `http://127.0.0.1:${server.address().port}/${marker}`;
    let closing;
    return {
        url,
        command: `curl --fail --silent --show-error ${url}`,
        requested,
        hasRequest: () => pending.size > 0,
        alive() {
            try {
                return childProcess.execFileSync("pgrep", ["-f", marker], { encoding: "utf8" }).trim().length > 0;
            } catch (error) {
                if (error.status === 1) return false;
                throw error;
            }
        },
        close() {
            closing ??= new Promise((resolve, reject) => {
                for (const response of pending) response.end("Test workload completed\n");
                server.close(error => error ? reject(error) : resolve());
            });
            return closing;
        },
    };
}
