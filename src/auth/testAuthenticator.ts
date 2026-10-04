/**
 * A passkey made in software, for tests only.
 *
 * Registration was tested up to the point an authenticator answers, because no
 * test could produce a response that verifies. This one can: a P-256 key, a
 * "none" attestation, user presence and verification both claimed - what a phone
 * sends, minus the phone - so a test can follow a passkey through the real
 * verification and into the database.
 */

import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';

const base64url = (bytes: Uint8Array | Buffer) => Buffer.from(bytes).toString('base64url');

export function softRegistration(input: {
  challenge: string;
  origin: string;
  rpId: string;
}): RegistrationResponseJSON {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credentialId = randomBytes(16);

  // COSE_Key: EC2, ES256, P-256, then the two coordinates.
  const cose = isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, new Uint8Array(Buffer.from(jwk.x!, 'base64url'))],
      [-3, new Uint8Array(Buffer.from(jwk.y!, 'base64url'))],
    ]),
  );

  const length = Buffer.alloc(2);
  length.writeUInt16BE(credentialId.length);
  const authData = Buffer.concat([
    createHash('sha256').update(input.rpId).digest(),
    // User present, user verified, attested credential data included.
    Buffer.from([0x01 | 0x04 | 0x40]),
    Buffer.alloc(4), // signature counter
    Buffer.alloc(16), // AAGUID
    length,
    credentialId,
    Buffer.from(cose),
  ]);

  const attestationObject = isoCBOR.encode(
    new Map<string, string | Map<string, string> | Uint8Array>([
      ['fmt', 'none'],
      ['attStmt', new Map<string, string>()],
      ['authData', new Uint8Array(authData)],
    ]),
  );
  const clientDataJSON = Buffer.from(
    JSON.stringify({ type: 'webauthn.create', challenge: input.challenge, origin: input.origin }),
  );

  return {
    id: base64url(credentialId),
    rawId: base64url(credentialId),
    type: 'public-key',
    clientExtensionResults: {},
    response: {
      clientDataJSON: base64url(clientDataJSON),
      attestationObject: base64url(attestationObject),
      transports: ['internal'],
    },
  };
}
