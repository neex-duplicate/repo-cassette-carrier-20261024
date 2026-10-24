import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({maxAttempts: 1});
const base = 'application/json';
const candidates = [
  ['nul', `${base}\0`],
  ['nul-nel', `${base}\0\u0085`],
  ['nul-api', `${base}\0&api-version=2012-02-12`],
  ['nul-crlf', `${base}\0\r\nX: y`],
  ['tab-nel', `${base}\t\u0085`],
  ['space-nel', `${base} \u0085`],
  ['vt-nel', `${base}\u000b\u0085`],
  ['ff-nel', `${base}\u000c\u0085`],
  ['del-nel', `${base}\u007f\u0085`],
  ['bom', `${base}\ufeff`],
  ['bom-nel', `${base}\ufeff\u0085`],
  ['shy-nel', `${base}\u00ad\u0085`],
  ['wordjoin-nel', `${base}\u2060\u0085`],
  ['zwnbsp-nel', `${base}\ufeff\u0085`],
  ['line-sep-nel', `${base}\u2028\u0085`],
  ['para-sep-nel', `${base}\u2029\u0085`],
  ['valid-before-nul', `${base}+x\0\u0085`],
];

const report = [];
for (const [label, mime] of candidates) {
  try {
    const created = await client.CreateArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name: `mime-control-${label}-${process.env.GITHUB_RUN_ID}`,
      version: 7,
      mimeType: StringValue.create({value: mime}),
    });
    report.push({label, ok: created.ok, hex: Buffer.from(mime).toString('hex'),
      path: new URL(created.signedUploadUrl).pathname.split('/').pop()});
  } catch (error) {
    report.push({label, ok: false, hex: Buffer.from(mime).toString('hex'),
      error: String(error).split(': ').at(-1).slice(0, 180)});
  }
}
console.log(`MIME_CONTROL ${JSON.stringify(report)}`);
