let input = "";
for await (const chunk of process.stdin) input += chunk;
const { relayHost, token, secretSentinel } = JSON.parse(input);
if (!relayHost || !token || !secretSentinel) throw new Error("probe arguments missing");

async function reachable(url, options = {}) {
  try {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(1500) });
    return { reachable: true, status: response.status, body: await response.text() };
  } catch {
    return { reachable: false, status: null, body: "" };
  }
}

const relay = await reachable(`http://${relayHost}:8080`, {
  headers: { authorization: `Bearer ${token}` }
});
const wrongGrant = await reachable(`http://${relayHost}:8080`, {
  headers: { authorization: "Bearer wrong" }
});
const internet = await reachable("https://example.com");
const metadata = await reachable("http://169.254.169.254/latest/meta-data/");
const host = await reachable("http://host.docker.internal:9");
const environment = JSON.stringify(process.env);
const result = {
  schemaVersion: 1,
  relay: relay.reachable && relay.status === 200,
  wrongGrantDenied: wrongGrant.reachable && wrongGrant.status === 401,
  arbitraryInternetDenied: !internet.reachable,
  cloudMetadataDenied: !metadata.reachable,
  hostServiceDenied: !host.reachable,
  otherCredentialDenied: !environment.includes(secretSentinel)
};
process.stdout.write(`${JSON.stringify(result)}\n`);
