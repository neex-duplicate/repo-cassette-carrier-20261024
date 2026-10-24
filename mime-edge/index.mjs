import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({maxAttempts: 1});
const base = 'application/json';
const candidates = [
  ['nel-semi', `${base}\u0085;x=y`],
  ['nel-semi-space', `${base}\u0085 ;x=y`],
  ['space-nel-semi', `${base} \u0085;x=y`],
  ['nel-semi-charset', `${base}\u0085;charset=utf-8`],
  ['nel-double-semi', `${base}\u0085;;x=y`],
  ['nel-comma', `${base}\u0085,text/plain`],
  ['nel-comment', `${base}\u0085(x)`],
  ['fs-semi', `${base}\u001c;x=y`],
  ['gs-semi', `${base}\u001d;x=y`],
  ['rs-semi', `${base}\u001e;x=y`],
  ['us-semi', `${base}\u001f;x=y`],
  ['nel-before-slash', `application\u0085/json`],
  ['nel-after-slash', `application/\u0085json`],
  ['quoted-nel-param', `${base};x="\u0085"`],
  ['rfc2231-nel', `${base};x*=iso-8859-1''%85`],
];

const report = [];
for (let i = 0; i < candidates.length; i++) {
  const [label, mime] = candidates[i];
  const name = `mime-edge-${process.env.GITHUB_RUN_ID}-${i}`;
  try {
    const result = await client.CreateArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
      version: 7,
      mimeType: StringValue.create({value: mime}),
    });
    report.push({label, hex: Buffer.from(mime).toString('hex'), ok: result.ok,
      path: new URL(result.signedUploadUrl).pathname.split('/').pop()});
  } catch (error) {
    report.push({label, hex: Buffer.from(mime).toString('hex'), error: String(error).split(': ').at(-1)});
  }
}
console.log(`MIME_EDGE ${JSON.stringify(report)}`);
