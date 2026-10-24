import {createHash} from 'node:crypto';

import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({maxAttempts: 1});
const nelJson = '\u0085application/json';
const results = [];

async function qualify(version) {
  const name = `cassette-legacy-${version}-${process.env.GITHUB_RUN_ID}`;
  const created = await client.CreateArtifact({
    workflowRunBackendId: ids.workflowRunBackendId,
    workflowJobRunBackendId: ids.workflowJobRunBackendId,
    name,
    version,
    mimeType: StringValue.create({value: nelJson}),
  });
  const blob = new BlobClient(created.signedUploadUrl).getBlockBlobClient();
  const placeholder = Buffer.from('{}');
  await blob.uploadData(placeholder, {blobHTTPHeaders: {blobContentType: nelJson}});
  const digest = createHash('sha256').update(placeholder).digest('hex');
  const finalized = await client.FinalizeArtifact({
    workflowRunBackendId: ids.workflowRunBackendId,
    workflowJobRunBackendId: ids.workflowJobRunBackendId,
    name,
    size: String(placeholder.length),
    hash: StringValue.create({value: `sha256:${digest}`}),
  });

  const artifactId = String(finalized.artifactId);
  const repository = `${process.env.GITHUB_REPOSITORY}/actions/artifacts/${artifactId}/zip`;
  const body = Buffer.from(JSON.stringify({
    full_name: repository,
    owner: {login: 'cassette', avatar_url: 'file:///proc/self/environ'},
    description: `Repo Cassette legacy v${version} carrier`,
    stargazers_count: 0,
  }));
  await blob.uploadData(body, {blobHTTPHeaders: {blobContentType: nelJson}});

  const api = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}` +
    `/actions/artifacts/${artifactId}/zip`;
  let observation = {apiStatus: null};
  for (let attempt = 0; attempt < 20; attempt++) {
    const response = await fetch(api, {
      redirect: 'manual',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        'user-agent': 'repo-cassette-legacy-qualification',
        'x-github-api-version': '2022-11-28',
      },
    });
    const location = response.headers.get('location');
    observation = {apiStatus: response.status};
    if (location) {
      const targetUrl = new URL(location);
      const target = await fetch(location, {redirect: 'manual'});
      const targetBody = Buffer.from(await target.arrayBuffer());
      const contentType = target.headers.get('content-type') || '';
      observation = {
        apiStatus: response.status,
        targetExtension: targetUrl.pathname.split('.').at(-1),
        rsctHex: Buffer.from(targetUrl.searchParams.get('rsct') || '', 'latin1').toString('hex'),
        targetStatus: target.status,
        contentTypeHex: Buffer.from(contentType, 'latin1').toString('hex'),
        bodyBytes: targetBody.length,
        bodyMatches: targetBody.equals(body),
      };
      if (target.status === 200 && targetBody.equals(body)) break;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  results.push({version, artifactId, repository, bodySha256: createHash('sha256').update(body).digest('hex'), ...observation});
}

for (const version of [0, 4, 6]) {
  try {
    await qualify(version);
  } catch (error) {
    results.push({version, error: String(error).slice(0, 240)});
  }
}

console.log(`LEGACY_QUALIFY ${JSON.stringify(results)}`);
