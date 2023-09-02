import '@sentry/tracing';

import { Errors } from '@lenster/data/errors';
import { adminAddresses } from '@lenster/data/staffs';
import hasOwnedLensProfiles from '@lenster/lib/hasOwnedLensProfiles';
import response from '@lenster/lib/response';
import validateLensAccount from '@lenster/lib/validateLensAccount';
import createSupabaseClient from '@lenster/supabase/createSupabaseClient';
import jwt from '@tsndr/cloudflare-worker-jwt';
import { boolean, object, string } from 'zod';

import { VERIFIED_KV_KEY } from '../constants';
import type { WorkerRequest } from '../types';

type ExtensionRequest = {
  id: string;
  isStaff?: boolean;
  isGardener?: boolean;
  isTrustedMember?: boolean;
  isVerified?: boolean;
  isPride?: boolean;
  highSignalNotificationFilter?: boolean;
  updateByAdmin?: boolean;
};

const validationSchema = object({
  id: string(),
  isStaff: boolean().optional(),
  isGardener: boolean().optional(),
  isTrustedMember: boolean().optional(),
  isVerified: boolean().optional(),
  isPride: boolean().optional(),
  highSignalNotificationFilter: boolean().optional(),
  updateByAdmin: boolean().optional()
});

export default async (request: WorkerRequest) => {
  const transaction = request.sentry?.startTransaction({
    name: '@lenster/preferences/updatePreferences'
  });

  const body = await request.json();
  if (!body) {
    return response({ success: false, error: Errors.NoBody });
  }

  const accessToken = request.headers.get('X-Access-Token');
  if (!accessToken) {
    return response({ success: false, error: Errors.NoAccessToken });
  }

  const validation = validationSchema.safeParse(body);

  if (!validation.success) {
    return response({ success: false, error: validation.error.issues });
  }

  const {
    id,
    isGardener,
    isStaff,
    isTrustedMember,
    updateByAdmin,
    isVerified,
    isPride,
    highSignalNotificationFilter
  } = body as ExtensionRequest;

  try {
    const isAuthenticated = await validateLensAccount(accessToken, true);
    if (!isAuthenticated) {
      return response({ success: false, error: Errors.InvalidAccesstoken });
    }

    const { payload } = jwt.decode(accessToken);
    if (updateByAdmin && !adminAddresses.includes(payload.id)) {
      return response({ success: false, error: Errors.NotAdmin });
    }

    const hasOwned = await hasOwnedLensProfiles(payload.id, id, true);
    if (!updateByAdmin && !hasOwned) {
      return new Response(
        JSON.stringify({ success: false, error: Errors.InvalidProfileId })
      );
    }

    const client = createSupabaseClient(request.env.SUPABASE_KEY);

    const { data, error } = await client
      .from('rights')
      .upsert({
        id,
        ...(updateByAdmin && {
          is_staff: isStaff,
          is_gardener: isGardener,
          is_trusted_member: isTrustedMember,
          is_verified: isVerified
        }),
        is_pride: isPride,
        high_signal_notification_filter: highSignalNotificationFilter
      })
      .select()
      .single();

    if (error) {
      throw error;
    }

    if (updateByAdmin) {
      // Clear cache in Cloudflare KV
      await request.env.PREFERENCES.delete(VERIFIED_KV_KEY);
    }

    return response({ success: true, result: data });
  } catch (error) {
    request.sentry?.captureException(error);
    throw error;
  } finally {
    transaction?.finish();
  }
};