import {createHash} from 'node:crypto';
import https from 'node:https';

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.setTimeout(15_000, () => req.destroy(new Error('request timeout')));
    req.end();
  });
}

const repository = 'yujeong050720/repo-cassette-private';
const runId = 40106752818;
const headers = {
  accept: 'application/vnd.github.v3+json',
  authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
  'user-agent': 'repo-cassette-solve-correlated-artifact-scan',
};
const listing = await request(
  `https://api.github.com/repos/${repository}/actions/artifacts?per_page=100`,
  {headers},
);
if (listing.status !== 200) throw new Error(`artifact listing returned ${listing.status}`);
const artifacts = (JSON.parse(listing.body).artifacts || []).filter(
  artifact => Number(artifact.workflow_run?.id) === runId,
);

async function inspect(artifact) {
  const route = `${repository}/actions/artifacts/${artifact.id}/zip`;
  const api = await request(`https://api.github.com/repos/${route}`, {headers});
  const item = {id: artifact.id, name: artifact.name, apiStatus: api.status};
  if (api.status !== 302 || !api.headers.location) return item;
  const signed = new URL(api.headers.location);
  const target = await request(signed, {headers: {
    'user-agent': 'repo-cassette-solve-correlated-artifact-scan',
  }});
  let document = null;
  try { document = JSON.parse(target.body); } catch {}
  return {
    ...item,
    extension: signed.pathname.split('.').at(-1),
    rsctHex: Buffer.from(signed.searchParams.get('rsct') || '', 'latin1').toString('hex'),
    targetStatus: target.status,
    contentTypeHex: Buffer.from(target.headers['content-type'] || '', 'latin1').toString('hex'),
    bodyBytes: target.body.length,
    bodySha256: createHash('sha256').update(target.body).digest('hex'),
    json: document && typeof document === 'object' && !Array.isArray(document),
    fullName: document?.full_name || null,
    avatarUrl: document?.owner?.avatar_url || null,
    routeMatches: document?.full_name === route,
  };
}

const report = [];
for (let offset = 0; offset < artifacts.length; offset += 8) {
  report.push(...await Promise.all(artifacts.slice(offset, offset + 8).map(inspect)));
}
report.sort((left, right) => left.name.localeCompare(right.name, undefined, {numeric: true}));
console.log('SCAN_YUJEONG', JSON.stringify({runId, count: report.length, report}));
