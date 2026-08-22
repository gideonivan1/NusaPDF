import { NextResponse } from 'next/server';
import { isResponse, requireCaller } from '@/lib/api/guard';
import { getQuota } from '@/lib/ai/quota';

export async function GET() {
  const caller = await requireCaller();
  if (isResponse(caller)) return caller;

  return NextResponse.json(await getQuota(caller.userId, caller.plan));
}
