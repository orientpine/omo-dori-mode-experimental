// Wire-level fake for the CLI subprocess: no Discord request leaves this process.
const fakeFetch = async (input: string | Request | URL) => {
  const url = String(input);
  console.log(`REQUEST ${url.split("/").pop()}`);
  return new Response(JSON.stringify({ id: "fake-message" }), { status: 200 });
};
globalThis.fetch = Object.assign(fakeFetch, { preconnect: fetch.preconnect });
