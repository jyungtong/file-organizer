import {
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { randomUUID } from 'node:crypto';
import { Resource } from 'sst';
import type {
  DynamoOAuthToken,
  DynamoUserState,
  PendingConfirmation,
  UserRule,
  UserStateType,
} from './types';

const dynamo = new DynamoDBClient({});
const TABLE = Resource.FileOrganizerTable.name;

// ─── Key helpers ──────────────────────────────────────────────────────────────

const userPk = (userId: number) => `USER#${userId}`;
const ruleSk = (ruleId: string) => `RULE#${ruleId}`;
const STATE_SK = 'STATE';
const OAUTH_SK = 'OAUTH';

// ─── User state ───────────────────────────────────────────────────────────────

export async function getUserState(userId: number): Promise<UserStateType> {
  const res = await dynamo.send(
    new GetItemCommand({
      TableName: TABLE,
      Key: marshall({ pk: userPk(userId), sk: STATE_SK }),
    }),
  );

  if (!res.Item) return { type: 'idle' };

  const item = unmarshall(res.Item) as DynamoUserState;

  // Expire stale states after 30 minutes (TTL handled by DynamoDB, but double-check)
  if (item.ttl && item.ttl < Math.floor(Date.now() / 1000)) {
    return { type: 'idle' };
  }

  return item.state;
}

export async function setUserState(
  userId: number,
  state: UserStateType,
): Promise<void> {
  const ttl = Math.floor(Date.now() / 1000) + 30 * 60; // 30 minutes

  await dynamo.send(
    new PutItemCommand({
      TableName: TABLE,
      Item: marshall({
        pk: userPk(userId),
        sk: STATE_SK,
        state,
        ttl,
      } satisfies DynamoUserState),
    }),
  );
}

export async function clearUserState(userId: number): Promise<void> {
  await setUserState(userId, { type: 'idle' });
}

export async function setPendingConfirmation(
  userId: number,
  confirmation: PendingConfirmation,
): Promise<void> {
  await setUserState(userId, { type: 'awaiting_confirmation', confirmation });
}

// ─── OAuth token ──────────────────────────────────────────────────────────────

export async function getOAuthToken(userId: number): Promise<{
  accessToken: string;
  refreshToken: string;
  expiryDate: number;
} | null> {
  const res = await dynamo.send(
    new GetItemCommand({
      TableName: TABLE,
      Key: marshall({ pk: userPk(userId), sk: OAUTH_SK }),
    }),
  );

  if (!res.Item) return null;

  const item = unmarshall(res.Item) as DynamoOAuthToken;
  return {
    accessToken: item.accessToken,
    refreshToken: item.refreshToken,
    expiryDate: item.expiryDate,
  };
}

export async function saveOAuthToken(
  userId: number,
  tokens: { accessToken: string; refreshToken: string; expiryDate: number },
): Promise<void> {
  await dynamo.send(
    new PutItemCommand({
      TableName: TABLE,
      Item: marshall({
        pk: userPk(userId),
        sk: OAUTH_SK,
        ...tokens,
      } satisfies DynamoOAuthToken),
    }),
  );
}

// ─── Custom rules ─────────────────────────────────────────────────────────────

export async function getRules(userId: number): Promise<UserRule[]> {
  const res = await dynamo.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: marshall({
        ':pk': userPk(userId),
        ':prefix': 'RULE#',
      }),
    }),
  );

  return (res.Items ?? []).map(
    (item) => (unmarshall(item) as { rule: UserRule }).rule,
  );
}

export async function addRule(
  userId: number,
  rule: Omit<UserRule, 'userId' | 'ruleId' | 'createdAt'>,
): Promise<UserRule> {
  const newRule: UserRule = {
    ...rule,
    userId,
    ruleId: randomUUID(),
    createdAt: new Date().toISOString(),
  };

  await dynamo.send(
    new PutItemCommand({
      TableName: TABLE,
      Item: marshall({
        pk: userPk(userId),
        sk: ruleSk(newRule.ruleId),
        rule: newRule,
      }),
    }),
  );

  return newRule;
}

export async function deleteRule(
  userId: number,
  ruleId: string,
): Promise<void> {
  await dynamo.send(
    new DeleteItemCommand({
      TableName: TABLE,
      Key: marshall({ pk: userPk(userId), sk: ruleSk(ruleId) }),
    }),
  );
}

// ─── Rule matching ────────────────────────────────────────────────────────────

/**
 * Find the first rule that matches a given file.
 * Matching checks:
 *   1. mimePrefix — file MIME type starts with rule.mimePrefix (if set)
 *   2. pattern    — fileName (lowercase) includes rule.pattern (lowercase)
 */
export function matchRule(
  rules: UserRule[],
  fileName: string,
  mimeType: string,
): UserRule | undefined {
  const lowerName = fileName.toLowerCase();

  return rules.find((rule) => {
    const mimeOk = !rule.mimePrefix || mimeType.startsWith(rule.mimePrefix);
    const patternOk = lowerName.includes(rule.pattern.toLowerCase());
    return mimeOk && patternOk;
  });
}
