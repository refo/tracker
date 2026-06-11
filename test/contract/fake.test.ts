import { FakeAdapter, FakeBackend } from "../helpers/fake-adapter.ts";
import { runMergeContractSuite } from "./merge-suite.ts";
import { runContractSuite } from "./suite.ts";

runContractSuite("FakeAdapter", {
  usernames: { first: "alice", second: "bob" },
  async make() {
    const backend = new FakeBackend();
    return {
      adapter: new FakeAdapter(backend, { id: "1", username: "alice", name: "Alice Aydın" }),
      secondAdapter: new FakeAdapter(backend, { id: "2", username: "bob", name: "Bob Bulut" }),
    };
  },
});

runMergeContractSuite("FakeAdapter", {
  async make() {
    const backend = new FakeBackend();
    const adapter = new FakeAdapter(backend, { id: "1", username: "alice", name: "Alice Aydın" });
    return {
      merge: adapter,
      issues: adapter,
      setCi: (prId, state) => backend.setCi(prId, state),
    };
  },
});
