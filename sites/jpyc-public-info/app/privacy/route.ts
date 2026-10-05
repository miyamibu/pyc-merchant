import { policyResponse } from '../policy-response.mjs';
export const dynamic = 'force-static';
export function GET() { return policyResponse('privacy'); }
