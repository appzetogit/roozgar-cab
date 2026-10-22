import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { Env, StandardCheckoutClient, StandardCheckoutPayRequest, PrefillUserLoginDetails } from '@phonepe-pg/pg-sdk-node';
import { ApiError } from '../../../../utils/ApiError.js';
import { asyncHandler } from '../../../../utils/asyncHandler.js';
import { User } from '../models/User.js';
import { createWebsiteBookingRequest } from '../services/websiteBookingService.js';
import { UserWallet } from '../models/UserWallet.js';
import { AdminBusinessSetting } from '../../admin/models/AdminBusinessSetting.js';
import { Notification } from '../../admin/promotions/models/Notification.js';
import { Driver } from '../../driver/models/Driver.js';
import { comparePassword, hashPassword, signAccessToken } from '../services/authService.js';
import { env } from '../../../../config/env.js';
import { uploadDataUrl } from '../../../../utils/fileUpload.js';
import { resolveConfiguredGatewayCredentials } from '../../services/paymentGatewayService.js';
import {
  consumeUserSignupSession,
  requireVerifiedUserSignupSession,
  startUserOtp,
  verifyUserOtp,
} from '../services/userOtpService.js';
import { assignPushTokenToEntity } from '../../services/pushTokenService.js';
import { SetPrice } from '../../admin/models/SetPrice.js';
import { applyDriverWalletAdjustment } from '../../driver/services/walletService.js';
import { emitToDriver } from '../../services/dispatchService.js';
import { sendPushNotificationToEntities } from '../../services/pushNotificationService.js';
import { listDriverServiceLocations } from '../../driver/services/serviceLocationService.js';
import { listSetPrices, listZones } from '../../admin/services/adminService.js';
import { findZoneByPickup } from '../../services/matchingService.js';
import { classifyTrip } from '../../services/tripCategoryService.js';
import { getSurgeAt, getSurgeProfiles, recordSurgeDemand, surgeForVehicle } from '../../services/surgeService.js';
import { verifyAccessToken } from '../../services/tokenService.js';
import { resolveRouteCached } from '../../services/routeService.js';
import {
  findActiveEmployeeByCode,
  normalizeEmployeeCode,
} from '../../admin/services/employeeAttributionService.js';
import {
  getUserSubscriptionSummary,
  listCustomerSubscriptionPlans,
  purchaseUserSubscription,
} from '../services/subscriptionService.js';
import { buildPaymentRequestContext, logPaymentDiagnostic, summarizeCheckoutUrl, summarizePhonePeCredentialMeta, summarizePhonePePayload, summarizePhonePeRequestBody } from '../../services/paymentDiagnostics.js';
import { getRequestClientIp } from '../../../../utils/clientIp.js';




const VALID_GENDERS = new Set(['male', 'female', 'other', 'prefer-not-to-say', '']);

const toCleanString = (value) => String(value || '').trim();

const normalizePhone = (value) => {
  const digits = toCleanString(value).replace(/\D/g, '');
  return digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits;
};

const normalizeEmail = (value) => toCleanString(value).toLowerCase();
const normalizeReferralCode = (value) => toCleanString(value).toUpperCase();

const normalizeGender = (value) => {
  const gender = toCleanString(value).toLowerCase();
  return VALID_GENDERS.has(gender) ? gender : 'prefer-not-to-say';
};

const validatePhone = (phone) => {
  if (!/^\d{10}$/.test(phone)) {
    throw new ApiError(400, 'A valid 10-digit phone number is required');
  }
};

const validateName = (name) => {
  if (!name || name.length < 2 || name.length > 80) {
    throw new ApiError(400, 'name must be between 2 and 80 characters');
  }
};

const validateEmail = (email) => {
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ApiError(400, 'A valid email address is required');
  }
};

const normalizeMoneyAmount = (value) => {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new ApiError(400, 'amount must be a positive number');
  }
  return Math.round(amount * 100) / 100;
};

const ensureUserWallet = async (userId) => {
  if (!userId) return;
  await UserWallet.updateOne(
    { userId },
    { $setOnInsert: { userId, balance: 0, refundWallet: 0, transactions: [] } },
    { upsert: true },
  );
};

const serializeUserWalletTransaction = (entry = {}) => ({
  id: entry._id,
  kind: entry.kind,
  amount: Number(entry.amount || 0),
  title: entry.title || '',
  counterpartyPhone: entry.counterpartyPhone || '',
  createdAt: entry.createdAt || null,
});

const buildUserWalletPayload = (wallet) => {
  const transactions = Array.isArray(wallet?.transactions) ? wallet.transactions : [];

  return {
    balance: Number(wallet?.balance || 0),
    refundWallet: Number(wallet?.refundWallet || 0),
    currency: 'INR',
    recentTransactions: transactions
      .slice()
      .reverse()
      .map(serializeUserWalletTransaction),
  };
};

const resolveRazorpayCredentials = async () => {
  return resolveConfiguredGatewayCredentials('razor_pay');
};

const resolvePhonePeCredentials = async () => {
  return resolveConfiguredGatewayCredentials('phone_pay');
};


export const listPublicServiceLocations = async (_req, res) => {
  const results = await listDriverServiceLocations();

  res.json({
    success: true,
    data: {
      results,
    },
  });
};


const normalizeOriginCandidate = (value = '') => {
  const trimmedValue = String(value || '').trim();
  if (!trimmedValue || trimmedValue === '*') {
    return '';
  }

  try {
    return new URL(trimmedValue).origin.replace(/\/+$/, '');
  } catch {
    return '';
  }
};

const isPublicWebOrigin = (value = '') => {
  const origin = normalizeOriginCandidate(value);
  if (!origin) {
    return false;
  }

  try {
    const { protocol, hostname } = new URL(origin);
    if (!['http:', 'https:'].includes(protocol)) {
      return false;
    }

    return !['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(hostname);
  } catch {
    return false;
  }
};

const getFrontendBaseUrl = (req) => {
  const configuredOrigins = [
    env.phonePeRedirectBaseUrl,
    env.publicFrontendUrl,
    ...String(env.corsOrigin || '')
      .split(',')
      .map((value) => value.trim()),
  ]
    .map(normalizeOriginCandidate)
    .filter(Boolean);

  const requestCandidates = [
    normalizeOriginCandidate(req?.get?.('origin')),
    normalizeOriginCandidate(req?.get?.('referer')),
    (() => {
      const forwardedProto = String(req?.get?.('x-forwarded-proto') || '').trim();
      const forwardedHost = String(req?.get?.('x-forwarded-host') || '').trim();
      if (!forwardedProto || !forwardedHost) {
        return '';
      }
      return normalizeOriginCandidate(`${forwardedProto}://${forwardedHost}`);
    })(),
    (() => {
      const host = String(req?.get?.('host') || '').trim();
      const proto =
        String(req?.protocol || '').trim() ||
        String(req?.get?.('x-forwarded-proto') || '').trim() ||
        'http';
      if (!host) {
        return '';
      }
      return normalizeOriginCandidate(`${proto}://${host}`);
    })(),
  ].filter(Boolean);

  const preferredPublicOrigin =
    configuredOrigins.find(isPublicWebOrigin) ||
    requestCandidates.find(isPublicWebOrigin);

  if (preferredPublicOrigin) {
    return preferredPublicOrigin;
  }

  return (
    configuredOrigins[0] ||
    requestCandidates[0] ||
    'http://localhost:5173'
  ).replace(/\/+$/, '');
};



const phonePeClientCache = new Map();

const getPhonePeCheckoutClient = ({
  clientId,
  clientSecret,
  clientVersion,
  environment,
}) => {
  const normalizedEnvironment = String(environment || 'test').trim().toLowerCase();
  const normalizedVersion = Number.parseInt(String(clientVersion || '1'), 10) || 1;
  const cacheKey = `${normalizedEnvironment}::${clientId}::${normalizedVersion}`;

  if (phonePeClientCache.has(cacheKey)) {
    return phonePeClientCache.get(cacheKey);
  }

  const client = StandardCheckoutClient.getInstance(
    clientId,
    clientSecret,
    normalizedVersion,
    normalizedEnvironment === 'production' ? Env.PRODUCTION : Env.SANDBOX,
  );

  phonePeClientCache.set(cacheKey, client);
  return client;
};


const phonePeRequest = async ({
  method,
  path,
  body,
  clientId,
  clientSecret,
  clientVersion,
  environment,
}) => {
  const normalizedMethod = String(method || 'GET').trim().toUpperCase();
  logPaymentDiagnostic({
    provider: 'phonepe',
    scope: 'user',
    stage: 'api-request',
    method: normalizedMethod,
    path,
    ...summarizePhonePeCredentialMeta({ clientId, clientVersion, environment }),
    request: summarizePhonePeRequestBody(body || {}),
  });
  const client = getPhonePeCheckoutClient({
    clientId,
    clientSecret,
    clientVersion,
    environment,
  });

  try {
    let payload = null;

    if (normalizedMethod === 'POST' && path === '/checkout/v2/pay') {
      const merchantOrderId = String(body?.merchantOrderId || '').trim();
      const amount = Number(body?.amount || 0);
      const redirectUrl = String(body?.paymentFlow?.merchantUrls?.redirectUrl || '').trim();

      if (!merchantOrderId || !amount || !redirectUrl) {
        throw new ApiError(400, 'PhonePe merchant order id, amount, and redirect URL are required');
      }

      const builder = StandardCheckoutPayRequest.builder()
        .merchantOrderId(merchantOrderId)
        .amount(amount)
        .redirectUrl(redirectUrl);

      if (body?.paymentFlow?.message) {
        builder.message(String(body.paymentFlow.message));
      }
      if (body?.expireAfter) {
        builder.expireAfter(Number(body.expireAfter));
      }
      if (body?.prefillUserLoginDetails?.phoneNumber) {
        const prefill = PrefillUserLoginDetails.builder()
          .phoneNumber(String(body.prefillUserLoginDetails.phoneNumber))
          .build();
        builder.prefillUserLoginDetails(prefill);
      }
      if (body?.metaInfo) {
        builder.metaInfo(body.metaInfo);
      }

      const request = builder.build();
      payload = await client.pay(request);
    } else if (normalizedMethod === 'GET' && path.includes('/checkout/v2/order/')) {
      const orderMatch = path.match(/\/checkout\/v2\/order\/([^/]+)\/status/i);
      const merchantOrderId = decodeURIComponent(orderMatch?.[1] || '').trim();

      if (!merchantOrderId) {
        throw new ApiError(400, 'PhonePe merchant order id is required');
      }

      payload = await client.getOrderStatus(merchantOrderId);
    } else {
      throw new ApiError(400, `Unsupported PhonePe operation: ${normalizedMethod} ${path}`);
    }

    logPaymentDiagnostic({
      provider: 'phonepe',
      scope: 'user',
      stage: 'api-success',
      method: normalizedMethod,
      path,
      statusCode: 200,
      ...summarizePhonePeCredentialMeta({ clientId, clientVersion, environment }),
      response: summarizePhonePePayload(payload || {}),
    });

    return payload;
  } catch (error) {
    const payload = error?.response || error?.payload || error?.data || null;
    const statusCode = Number(error?.statusCode || error?.status || 502);

    logPaymentDiagnostic({
      provider: 'phonepe',
      scope: 'user',
      stage: 'api-failed',
      level: 'error',
      method: normalizedMethod,
      path,
      statusCode,
      ...summarizePhonePeCredentialMeta({ clientId, clientVersion, environment }),
      response: summarizePhonePePayload(payload || {}),
      providerMessage:
        error?.message ||
        payload?.message ||
        payload?.responseCodeDescription ||
        payload?.detailedErrorCode ||
        '',
    });
    throw new ApiError(
      statusCode,
      error?.message || payload?.message || payload?.code || 'PhonePe request failed',
    );
  }
};

const razorpayRequest = async ({ method, path, body, keyId, keySecret }) => {
  const credentials = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
  const response = await fetch(`https://api.razorpay.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(response.status || 502, payload?.error?.description || payload?.error?.message || 'Razorpay request failed');
  }

  return payload;
};





















export const getIntercityPackageCatalog = async (_req, res) => {
  const items = await SetPrice.find({
    pricing_scope: 'package',
    active: 1,
    status: 'active',
    package_availability: 'available',
  })
    .populate('service_location_id', 'name service_location_name')
    .populate('package_vehicle_prices.vehicle_type', 'name capacity icon map_icon image icon_types dispatch_type')
    .sort({ package_destination: 1, createdAt: -1 })
    .lean();

  const results = items.map((item) => {
    const serviceLocation = item.service_location_id || {};

    return {
      id: String(item._id),
      serviceLocationId: serviceLocation._id ? String(serviceLocation._id) : '',
      serviceLocationName: serviceLocation.name || serviceLocation.service_location_name || '',
      destination: String(item.package_destination || '').trim(),
      availability: String(item.package_availability || 'available').trim().toLowerCase(),
      vehicles: Array.isArray(item.package_vehicle_prices)
        ? item.package_vehicle_prices
            .filter((row) => row?.vehicle_type)
            .map((row, index) => ({
              id: `${String(item._id)}:${String(row.vehicle_type?._id || index)}`,
              vehicleTypeId: row.vehicle_type?._id ? String(row.vehicle_type._id) : '',
              vehicleName: row.vehicle_type?.name || 'Vehicle',
              capacity: Number(row.vehicle_type?.capacity || 0),
              icon: row.vehicle_type?.map_icon || row.vehicle_type?.icon || row.vehicle_type?.image || '',
              iconType: row.vehicle_type?.icon_types || row.vehicle_type?.name || '',
              dispatchType: String(row.vehicle_type?.dispatch_type || 'normal').trim().toLowerCase(),
              basePrice: Number(row.base_price ?? 0),
              freeDistance: Number(row.free_distance ?? 0),
              distancePrice: Number(row.distance_price ?? 0),
              freeTime: Number(row.free_time ?? 0),
              timePrice: Number(row.time_price ?? 0),
              adminCommisionType: Number(row.admin_commision_type ?? 1),
              adminCommision: Number(row.admin_commision ?? 0),
              adminCommissionTypeFromDriver: Number(row.admin_commission_type_from_driver ?? 1),
              adminCommissionFromDriver: Number(row.admin_commission_from_driver ?? 0),
              adminCommissionTypeForOwner: Number(row.admin_commission_type_for_owner ?? 1),
              adminCommissionForOwner: Number(row.admin_commission_for_owner ?? 0),
              serviceTax: Number(row.service_tax ?? 0),
              cancellationFee: Number(row.cancellation_fee ?? 0),
            }))
        : [],
    };
  });

  res.json({
    success: true,
    results,
  });
};













const toUserPayload = (user, options = {}) => ({
  id: user._id,
  name: user.name || '',
  phone: user.phone || '',
  email: user.email || '',
  gender: user.gender || '',
  profileImage: user.profileImage || '',
  governmentIdProof: user.governmentIdProof || {
    type: '',
    imageUrl: '',
    backImageUrl: '',
    fileName: '',
    backFileName: '',
    uploadedAt: null,
    backUploadedAt: null,
  },
  referralCode: user.referralCode || '',
  referralCount: Number(user.referralCount || 0),
  deletionRequestStatus: user.deletionRequest?.status || 'none',
  referralCode: user.referralCode || '',
  referralCount: Number(user.referralCount || 0),
  currentRideId: user.currentRideId || null,
  subscriptionSummary: options.subscriptionSummary || {
    activeCount: 0,
    hasUnlimitedPlan: false,
    availableRideCredits: 0,
    activePlans: [],
  },
});

const ensureUserCanLogin = (user) => {
  if (user.deletedAt || user.isActive === false || user.active === false) {
    throw new ApiError(403, 'User account is not active');
  }
};

const canRestoreUserForSignup = (user) => Boolean(user?.deletedAt);

const VALID_GOVERNMENT_ID_TYPES = new Set(['aadhaar', 'voter_id', 'passport', 'driving_license', 'other']);

const normalizeGovernmentIdProof = (input = {}, { required = false } = {}) => {
  const type = toCleanString(input.type).toLowerCase();
  const imageUrl = toCleanString(input.imageUrl || input.url || input.secureUrl);
  const backImageUrl = toCleanString(input.backImageUrl || input.backUrl || input.backSecureUrl);
  const fileName = toCleanString(input.fileName || input.name || 'government-id');
  const backFileName = toCleanString(input.backFileName || input.backName || 'government-id-back');

  if (!imageUrl && !backImageUrl && !required) {
    return {
      type: '',
      imageUrl: '',
      backImageUrl: '',
      fileName: '',
      backFileName: '',
      uploadedAt: null,
      backUploadedAt: null,
    };
  }

  if (!VALID_GOVERNMENT_ID_TYPES.has(type)) {
    throw new ApiError(400, 'A valid government ID type is required');
  }

  if (required && !imageUrl) {
    throw new ApiError(400, 'Government ID front image is required');
  }

  if (required && !backImageUrl) {
    throw new ApiError(400, 'Government ID back image is required');
  }

  return {
    type,
    imageUrl,
    backImageUrl,
    fileName: fileName || `${type}-proof`,
    backFileName: backFileName || `${type}-proof-back`,
    uploadedAt: input.uploadedAt ? new Date(input.uploadedAt) : new Date(),
    backUploadedAt: backImageUrl
      ? input.backUploadedAt
        ? new Date(input.backUploadedAt)
        : new Date()
      : null,
  };
};


const buildReactivatedUserPayload = async ({
  req,
  name,
  phone,
  email,
  countryCode,
  gender,
  profileImage,
  governmentIdProof,
  referrer,
  employee,
}) => ({
  name,
  phone,
  countryCode,
  email,
  gender,
  profileImage,
  governmentIdProof,
  password: await hashPassword(String(req.body.password || '').trim() || crypto.randomBytes(24).toString('hex')),
  isVerified: true,
  referredBy: referrer?._id || null,
  acquiredByEmployeeId: employee?._id || null,
  acquiredByEmployeeCode: employee?.employeeCode || '',
  deletedAt: null,
  deletion_reason: '',
  active: true,
  isActive: true,
  deletionRequest: {
    status: 'none',
    reason: '',
    requestedAt: null,
    reviewedAt: null,
    reviewedBy: null,
    adminNote: '',
  },
});

const createUserSession = (user) => ({
  token: signAccessToken({ sub: String(user._id), role: 'user' }),
  user: toUserPayload(user),
});

const generateUserReferralCode = (user) => {
  const idPart = String(user?._id || '').slice(-6).toUpperCase();
  const phonePart = String(user?.phone || '').slice(-4);
  return `USR${phonePart}${idPart}`.replace(/\W/g, '');
};

const getUserReferralProgramSettings = async () => {
  const setting = await AdminBusinessSetting.findOne({ scope: 'default' }).lean();
  const userReferral = setting?.referral?.user || {};

  return {
    enabled: Boolean(userReferral.enabled),
    type: String(userReferral.type || 'instant_referrer').trim().toLowerCase(),
    amount: Math.max(0, Number(userReferral.amount || 0) || 0),
    rideCount: Math.max(0, Number(userReferral.ride_count || 0) || 0),
  };
};

const findUserByReferralCode = async (referralCode) => {
  const normalizedCode = normalizeReferralCode(referralCode);

  if (!normalizedCode) {
    return null;
  }

  return User.findOne({ referralCode: normalizedCode });
};

const creditUserWalletByReference = async ({ userId, amount, title, referenceKey }) => {
  const normalizedAmount = Math.max(0, Number(amount || 0) || 0);
  const normalizedReferenceKey = toCleanString(referenceKey);

  if (!userId || normalizedAmount <= 0 || !normalizedReferenceKey) {
    return 'skipped';
  }

  await ensureUserWallet(userId);

  const existingTransaction = await UserWallet.findOne({
    userId,
    'transactions.referenceKey': normalizedReferenceKey,
  })
    .select('_id')
    .lean();

  if (existingTransaction) {
    return 'existing';
  }

  await UserWallet.updateOne(
    { userId },
    {
      $inc: { balance: normalizedAmount },
      $push: {
        transactions: {
          $each: [
            {
              kind: 'credit',
              amount: normalizedAmount,
              title: toCleanString(title) || 'Referral Reward',
              referenceKey: normalizedReferenceKey,
            },
          ],
          $slice: -50,
        },
      },
    },
  );

  return 'credited';
};

const processSignupReferralRewards = async ({ user, referrer }) => {
  if (!user?._id || !referrer?._id) {
    return;
  }

  const settings = await getUserReferralProgramSettings();
  if (!settings.enabled || settings.amount <= 0) {
    return;
  }

  const referralType = settings.type;
  const rewardBaseKey = `user-referral:signup:${String(user._id)}`;

  if (referralType === 'instant_referrer' || referralType === 'instant_referrer_new') {
    await creditUserWalletByReference({
      userId: referrer._id,
      amount: settings.amount,
      title: `Referral reward for inviting ${user.phone}`,
      referenceKey: `${rewardBaseKey}:referrer`,
    });
  }

  if (referralType === 'instant_referrer_new') {
    await creditUserWalletByReference({
      userId: user._id,
      amount: settings.amount,
      title: 'Welcome referral reward',
      referenceKey: `${rewardBaseKey}:new-user`,
    });
    user.referralRewardGrantedAt = user.referralRewardGrantedAt || new Date();
    await user.save();
  }
};

export const registerUser = async (req, res) => {
  const name = toCleanString(req.body.name);
  const phone = normalizePhone(req.body.phone);
  const email = normalizeEmail(req.body.email);
  const countryCode = toCleanString(req.body.countryCode) || '+91';
  const gender = normalizeGender(req.body.gender);
  const profileImage = toCleanString(req.body.profileImage);
  const governmentIdProof = normalizeGovernmentIdProof(req.body.governmentIdProof || {}, { required: false });
  const referralCode = normalizeReferralCode(req.body.referralCode);
  const employeeCode = normalizeEmployeeCode(req.body.employeeCode);

  validateName(name);
  validatePhone(phone);
  validateEmail(email);

  const existingUser = await User.findOne({ phone });

  const referrer = referralCode ? await findUserByReferralCode(referralCode) : null;
  const employee = employeeCode ? await findActiveEmployeeByCode(employeeCode) : null;

  if (referralCode && !referrer) {
    throw new ApiError(400, 'Invalid referral code');
  }

  if (employeeCode && !employee) {
    throw new ApiError(400, 'Invalid employee code');
  }

  if (existingUser && !canRestoreUserForSignup(existingUser)) {
    throw new ApiError(409, 'Phone number is already registered');
  }

  const userPayload = await buildReactivatedUserPayload({
    req,
    name,
    phone,
    email,
    countryCode,
    gender,
    profileImage,
    governmentIdProof,
    referrer,
    employee,
  });

  const user = existingUser
    ? await User.findByIdAndUpdate(existingUser._id, { $set: userPayload }, { new: true, runValidators: true })
    : await User.create(userPayload);

  if (!String(user.referralCode || '').trim()) {
    user.referralCode = generateUserReferralCode(user);
    await user.save();
  }

  if (referrer?._id) {
    await User.updateOne({ _id: referrer._id }, { $inc: { referralCount: 1 } });
    await processSignupReferralRewards({ user, referrer });
  }

  res.status(201).json({
    success: true,
    data: createUserSession(user),
  });
};

const serializeUserNotification = (item = {}) => ({
  id: String(item._id || ''),
  title: String(item.push_title || '').trim(),
  body: String(item.message || '').trim(),
  image: item.image || '',
  sentAt: item.sent_at || item.createdAt || null,
  serviceLocationId: item.service_location_id || null,
});

export const getUserNotifications = async (req, res) => {
  const user = await User.findById(req.auth.sub).lean();

  if (!user) {
    throw new ApiError(404, 'User not found');
  }

  // Users don't typically have a service_location_id in their profile like drivers do in this schema,
  // but if they did, we would use it. For now, we fetch all user-targeted notifications.
  const query = {
    status: 'sent',
    send_to: { $in: ['all', 'users'] },
  };

  const notifications = await Notification.find(query)
    .sort({ sent_at: -1, createdAt: -1 })
    .limit(100)
    .lean();

  res.json({
    success: true,
    data: {
      results: notifications.map(serializeUserNotification),
    },
  });
};

export const deleteUserNotification = async (req, res) => {
  // In a real multi-tenant app, you'd mark it as read/deleted for THIS user in a pivot table.
  // However, the current driver implementation seems to imply a simpler model or global clear for the demo.
  // For consistency with the user's request for "single clear", we'll just return success 
  // as the frontend is already filtering its local state.
  // If we wanted to persist this per user, we'd need a UserNotification model.
  res.json({
    success: true,
    message: 'Notification removed',
  });
};

export const clearAllUserNotifications = async (req, res) => {
  res.json({
    success: true,
    message: 'All notifications cleared',
  });
};

export const signupUser = async (req, res) => {
  const name = toCleanString(req.body.name);
  const phone = normalizePhone(req.body.phone);
  const email = normalizeEmail(req.body.email);
  const countryCode = toCleanString(req.body.countryCode) || '+91';
  const gender = normalizeGender(req.body.gender);
  const profileImage = toCleanString(req.body.profileImage);
  const governmentIdProof = normalizeGovernmentIdProof(req.body.governmentIdProof || {}, { required: false });
  const referralCode = normalizeReferralCode(req.body.referralCode);
  const employeeCode = normalizeEmployeeCode(req.body.employeeCode);

  validateName(name);
  validatePhone(phone);
  validateEmail(email);

  const signupSession = await requireVerifiedUserSignupSession(phone);

  const existingUser = await User.findOne({ phone });

  const referrer = referralCode ? await findUserByReferralCode(referralCode) : null;
  const employee = employeeCode ? await findActiveEmployeeByCode(employeeCode) : null;

  if (referralCode && !referrer) {
    throw new ApiError(400, 'Invalid referral code');
  }

  if (employeeCode && !employee) {
    throw new ApiError(400, 'Invalid employee code');
  }

  if (existingUser && !canRestoreUserForSignup(existingUser)) {
    throw new ApiError(409, 'Phone number is already registered');
  }

  const userPayload = await buildReactivatedUserPayload({
    req,
    name,
    phone,
    email,
    countryCode,
    gender,
    profileImage,
    governmentIdProof,
    referrer,
    employee,
  });

  const user = existingUser
    ? await User.findByIdAndUpdate(existingUser._id, { $set: userPayload }, { new: true, runValidators: true })
    : await User.create(userPayload);

  if (!String(user.referralCode || '').trim()) {
    user.referralCode = generateUserReferralCode(user);
    await user.save();
  }

  if (referrer?._id) {
    await User.updateOne({ _id: referrer._id }, { $inc: { referralCount: 1 } });
    await processSignupReferralRewards({ user, referrer });
  }

  await consumeUserSignupSession(signupSession);

  res.status(201).json({
    success: true,
    data: createUserSession(user),
  });
};

export const startUserOtpRequest = async (req, res) => {
  const result = await startUserOtp(req.body);
  res.status(201).json({ success: true, data: result });
};

export const verifyUserOtpRequest = async (req, res) => {
  const result = await verifyUserOtp(req.body);
  res.json({ success: true, data: result });
};

export const loginUser = async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const password = String(req.body.password || '');

  validatePhone(phone);

  if (!password) {
    throw new ApiError(400, 'password is required');
  }

  const user = await User.findOne({ phone }).select('+password');

  if (!user || !user.password || !(await comparePassword(password, user.password))) {
    throw new ApiError(401, 'Invalid phone or password');
  }

  ensureUserCanLogin(user);

  res.json({
    success: true,
    data: createUserSession(user),
  });
};

export const verifyUserPhoneForOtpLogin = async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  validatePhone(phone);

  const user = await User.findOne({ phone }).lean();

  if (!user || user.deletedAt) {
    res.json({
      success: true,
      data: {
        exists: false,
        user: null,
      },
    });
    return;
  }

  ensureUserCanLogin(user);

  res.json({
    success: true,
    data: {
      exists: true,
      ...createUserSession(user),
    },
  });
};

export const saveUserFcmToken = async (req, res) => {
  const user = await User.findById(req.auth?.sub);

  if (!user) {
    throw new ApiError(404, 'User not found');
  }

  ensureUserCanLogin(user);

  const saved = assignPushTokenToEntity(user, {
    token: req.body?.token,
    platform: req.body?.platform,
  });

  await user.save();

  res.json({
    success: true,
    data: {
      message: 'FCM token saved successfully',
      platform: saved.platform,
      field: saved.fieldName,
    },
  });
};

export const getCurrentUser = async (req, res) => {
  const user = await User.findById(req.auth?.sub);

  if (!user) {
    throw new ApiError(404, 'User not found');
  }

  if (!String(user.referralCode || '').trim()) {
    user.referralCode = generateUserReferralCode(user);
    await user.save();
  }

  const subscriptionSummary = await getUserSubscriptionSummary(user._id);

  res.json({
    success: true,
    data: {
      user: {
        ...toUserPayload(user, { subscriptionSummary }),
        createdAt: user.createdAt || null,
      },
    },
  });
};

export const uploadUserProfileImage = async (req, res) => {
  const dataUrl = String(req.body?.dataUrl || '');

  if (!dataUrl) {
    throw new ApiError(400, 'dataUrl is required');
  }

  if (dataUrl.length > 12_000_000) {
    throw new ApiError(413, 'Image is too large');
  }

  const uploadResult = await uploadDataUrl({
    dataUrl,
    folder: `${env.uploads.folder}/user-profile`,
    publicIdPrefix: 'user-profile',
  });

  res.status(201).json({
    success: true,
    data: {
      secureUrl: uploadResult.secureUrl,
      publicId: uploadResult.publicId,
    },
  });
};

export const updateCurrentUser = async (req, res) => {
  const userId = req.auth?.sub;

  const user = await User.findById(userId);

  if (!user) {
    throw new ApiError(404, 'User not found');
  }

  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'name')) {
    const name = toCleanString(req.body.name);
    validateName(name);
    user.name = name;
  }

  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'email')) {
    const email = normalizeEmail(req.body.email);
    validateEmail(email);
    user.email = email;
  }

  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'profileImage')) {
    user.profileImage = toCleanString(req.body.profileImage);
  }

  await user.save();

  res.json({
    success: true,
    data: {
      user: toUserPayload(user),
    },
  });
};

export const getAvailableSubscriptionPlans = async (_req, res) => {
  const plans = await listCustomerSubscriptionPlans();

  res.json({
    success: true,
    data: {
      results: plans,
    },
  });
};

export const getMySubscriptions = async (req, res) => {
  const summary = await getUserSubscriptionSummary(req.auth?.sub);

  res.json({
    success: true,
    data: summary,
  });
};

export const buySubscription = async (req, res) => {
  const result = await purchaseUserSubscription({
    userId: req.auth?.sub,
    planId: req.body?.planId,
    paymentSource: 'wallet',
  });

  res.status(201).json({
    success: true,
    data: result,
    message: 'Subscription purchased successfully',
  });
};

export const requestAccountDeletion = async (req, res) => {
  const userId = req.auth?.sub;
  const reason = toCleanString(req.body?.reason);

  if (!reason) {
    throw new ApiError(400, 'Deletion reason is required');
  }

  const user = await User.findById(userId);

  if (!user) {
    throw new ApiError(404, 'User not found');
  }

  if (user.deletedAt || user.isActive === false || user.active === false) {
    throw new ApiError(400, 'Account is already inactive');
  }

  if (user.deletionRequest?.status === 'pending') {
    res.json({
      success: true,
      data: {
        deletionRequestStatus: 'pending',
        requestedAt: user.deletionRequest.requestedAt || null,
      },
      message: 'Deletion request is already pending admin review',
    });
    return;
  }

  user.deletionRequest = {
    status: 'pending',
    reason: reason.slice(0, 300),
    requestedAt: new Date(),
    reviewedAt: null,
    reviewedBy: null,
    adminNote: '',
  };

  await user.save();

  res.status(201).json({
    success: true,
    data: {
      deletionRequestStatus: user.deletionRequest.status,
      requestedAt: user.deletionRequest.requestedAt,
    },
  });
};

export const getUserWallet = async (req, res) => {
  const userId = req.auth?.sub;
  const user = await User.findById(userId).select('_id').lean();

  if (!user) {
    throw new ApiError(404, 'User not found');
  }

  await ensureUserWallet(userId);
  const wallet = await UserWallet.findOne({ userId }).select('balance refundWallet transactions').slice('transactions', -10).lean();
  const transactions = Array.isArray(wallet?.transactions) ? wallet.transactions : [];

  res.json({
    success: true,
    data: buildUserWalletPayload({ ...wallet, transactions }),
  });
};

export const topupUserWallet = async (req, res) => {
  const amount = normalizeMoneyAmount(req.body?.amount);
  const userId = req.auth?.sub;
  const user = await User.findById(userId).select('_id').lean();

  if (!user) {
    throw new ApiError(404, 'User not found');
  }

  const tx = {
    kind: 'credit',
    amount,
    title: 'Wallet Refilled',
    provider: 'manual',
  };

  await ensureUserWallet(userId);

  await UserWallet.updateOne(
    { userId },
    {
      $inc: { balance: amount },
      $push: { transactions: { $each: [tx], $slice: -50 } },
    },
  );

  const updatedWallet = await UserWallet.findOne({ userId }).select('balance transactions').slice('transactions', -10).lean();
  const updatedWalletWithRefund = updatedWallet
    ? { ...updatedWallet, refundWallet: Number(updatedWallet.refundWallet || 0) }
    : updatedWallet;
  const transactions = Array.isArray(updatedWallet?.transactions) ? updatedWallet.transactions : [];

  res.status(201).json({
    success: true,
    data: buildUserWalletPayload({ ...updatedWalletWithRefund, transactions }),
  });
};

export const transferUserWallet = async (req, res) => {
  const amount = normalizeMoneyAmount(req.body?.amount);
  const recipientPhone = normalizePhone(req.body?.phone);
  validatePhone(recipientPhone);

  const senderId = req.auth?.sub;

  const sender = await User.findById(senderId).select({ phone: 1 }).lean();
  if (!sender) {
    throw new ApiError(404, 'User not found');
  }

  if (sender.phone === recipientPhone) {
    throw new ApiError(400, 'Cannot transfer to same phone number');
  }

  const recipient = await User.findOne({ phone: recipientPhone }).select({ _id: 1 }).lean();
  if (!recipient) {
    throw new ApiError(404, 'Recipient not found');
  }

  await ensureUserWallet(senderId);
  await ensureUserWallet(recipient._id);

  const transferId = crypto.randomUUID();

  const debitTx = {
    kind: 'debit',
    amount,
    title: 'Wallet Transfer',
    counterpartyPhone: recipientPhone,
    provider: 'internal',
    providerPaymentId: transferId,
  };

  const creditTx = {
    kind: 'credit',
    amount,
    title: 'Wallet Received',
    counterpartyPhone: sender.phone || '',
    provider: 'internal',
    providerPaymentId: transferId,
  };

  const senderUpdate = await UserWallet.updateOne(
    { userId: senderId, balance: { $gte: amount } },
    { $inc: { balance: -amount }, $push: { transactions: { $each: [debitTx], $slice: -50 } } },
  );

  if (!senderUpdate?.modifiedCount) {
    throw new ApiError(400, 'Insufficient wallet balance');
  }

  const recipientUpdate = await UserWallet.updateOne(
    { userId: recipient._id },
    { $inc: { balance: amount }, $push: { transactions: { $each: [creditTx], $slice: -50 } } },
  );

  if (!recipientUpdate?.modifiedCount) {
    await UserWallet.updateOne(
      { userId: senderId },
      { $inc: { balance: amount }, $pull: { transactions: { providerPaymentId: transferId } } },
    );
    throw new ApiError(500, 'Transfer failed');
  }

  const wallet = await UserWallet.findOne({ userId: senderId }).select('balance refundWallet transactions').slice('transactions', -10).lean();

  const transactions = Array.isArray(wallet?.transactions) ? wallet.transactions : [];

  res.status(201).json({
    success: true,
    data: buildUserWalletPayload({ ...wallet, transactions }),
  });
};

export const transferUserWalletToDriver = async (req, res) => {
  const amount = normalizeMoneyAmount(req.body?.amount);
  const driverPhone = normalizePhone(req.body?.phone);
  validatePhone(driverPhone);

  const senderId = req.auth?.sub;
  const sender = await User.findById(senderId).select({ phone: 1, firstName: 1, lastName: 1, name: 1 }).lean();

  if (!sender) {
    throw new ApiError(404, 'User not found');
  }

  if (sender.phone === driverPhone) {
    throw new ApiError(400, 'Cannot transfer to same phone number');
  }

  const recipientDriver = await Driver.findOne({ phone: driverPhone })
    .select({ _id: 1, phone: 1, firstName: 1, lastName: 1, name: 1 })
    .lean();

  if (!recipientDriver) {
    throw new ApiError(404, 'Driver not found');
  }

  await ensureUserWallet(senderId);
  const transferId = crypto.randomUUID();
  const senderDisplayName = String(
    sender.name || [sender.firstName, sender.lastName].filter(Boolean).join(' ') || 'Rider',
  ).trim();
  const driverDisplayName = String(
    recipientDriver.name || [recipientDriver.firstName, recipientDriver.lastName].filter(Boolean).join(' ') || 'Driver',
  ).trim();

  const session = await mongoose.startSession();

  try {
    session.startTransaction();

    const senderWallet = await UserWallet.findOne({ userId: senderId }).session(session);
    if (!senderWallet) {
      throw new ApiError(404, 'User wallet not found');
    }

    if (Number(senderWallet.balance || 0) < amount) {
      throw new ApiError(400, 'Insufficient wallet balance');
    }

    senderWallet.balance = Math.round((Number(senderWallet.balance || 0) - amount) * 100) / 100;
    senderWallet.transactions.push({
      kind: 'debit',
      amount,
      title: `Sent to driver ${driverDisplayName}`,
      counterpartyPhone: driverPhone,
      provider: 'internal_driver_wallet_transfer',
      providerPaymentId: transferId,
    });
    senderWallet.transactions = senderWallet.transactions.slice(-50);
    await senderWallet.save({ session });

    const walletUpdate = await applyDriverWalletAdjustment({
      driverId: recipientDriver._id,
      amount,
      type: 'adjustment',
      description: `Received from rider wallet (${senderDisplayName})`,
      metadata: {
        source: 'user_wallet_transfer',
        transferId,
        senderUserId: senderId,
        senderPhone: sender.phone || '',
        senderName: senderDisplayName,
      },
      session,
    });

    await session.commitTransaction();

    emitToDriver(recipientDriver._id, 'driver:wallet:updated', {
      wallet: walletUpdate.wallet,
      transaction: walletUpdate.transaction,
      notification: {
        title: 'Wallet credited',
        body: `Rs ${amount.toFixed(2)} received from rider wallet`,
      },
    });

    sendPushNotificationToEntities({
      driverIds: [recipientDriver._id],
      title: 'Wallet credited',
      body: `Rs ${amount.toFixed(2)} received from rider wallet`,
      data: {
        type: 'driver_wallet_credit',
        amount: String(amount),
        transferId,
      },
    }).catch(() => {});

    const refreshedWallet = await UserWallet.findOne({ userId: senderId })
      .select('balance refundWallet transactions')
      .slice('transactions', -10)
      .lean();

    res.status(201).json({
      success: true,
      data: {
        ...buildUserWalletPayload(refreshedWallet),
        transfer: {
          id: transferId,
          amount,
          driverPhone,
          driverName: driverDisplayName,
        },
      },
    });
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
};

export const createRazorpayWalletTopupOrder = async (req, res) => {
  const amount = normalizeMoneyAmount(req.body?.amount);
  const { keyId, keySecret } = await resolveRazorpayCredentials();

  const amountPaise = Math.round(amount * 100);
  const userId = String(req.auth?.sub || '');
  const compactUserId = userId.replace(/[^a-zA-Z0-9]/g, '').slice(-8) || 'usr';
  const receipt = `uwal_${compactUserId}_${Date.now().toString(36)}`;
  const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
  const host = req.get('x-forwarded-host') || req.get('host') || 'localhost:5000';
  const backendOrigin = `${proto}://${host}`;
  const callbackUrl = `${backendOrigin}/api/v1/users/wallet/razorpay/callback`;

  const order = await razorpayRequest({
    method: 'POST',
    path: '/orders',
    body: {
      amount: amountPaise,
      currency: 'INR',
      receipt,
      notes: { userId },
    },
    keyId,
    keySecret,
  });

  res.status(201).json({
    success: true,
    data: {
      keyId,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency || 'INR',
      callbackUrl,
    },
  });
};

const verifyAndApplyUserRazorpayWalletTopup = async ({
  orderId,
  paymentId,
  signature,
  userId: requestedUserId = '',
} = {}) => {
  const normalizedOrderId = String(orderId || '').trim();
  const normalizedPaymentId = String(paymentId || '').trim();
  const normalizedSignature = String(signature || '').trim();

  if (!normalizedOrderId || !normalizedPaymentId || !normalizedSignature) {
    throw new ApiError(400, 'Payment verification fields are required');
  }

  const { keyId, keySecret } = await resolveRazorpayCredentials();

  const expectedSignature = crypto
    .createHmac('sha256', keySecret)
    .update(`${normalizedOrderId}|${normalizedPaymentId}`)
    .digest('hex');

  if (expectedSignature !== normalizedSignature) {
    throw new ApiError(400, 'Invalid payment signature');
  }

  const order = await razorpayRequest({
    method: 'GET',
    path: `/orders/${encodeURIComponent(normalizedOrderId)}`,
    keyId,
    keySecret,
  });

  const amountPaise = Number(order?.amount);
  if (!Number.isFinite(amountPaise) || amountPaise <= 0) {
    throw new ApiError(400, 'Invalid order amount');
  }

  const orderUserId = String(order?.notes?.userId || '').trim();
  const effectiveUserId = String(requestedUserId || orderUserId).trim();

  if (!effectiveUserId) {
    throw new ApiError(400, 'User reference is missing from this Razorpay order');
  }

  if (requestedUserId && orderUserId && requestedUserId !== orderUserId) {
    throw new ApiError(403, 'This Razorpay order does not belong to the authenticated user');
  }

  const amount = Math.round(amountPaise) / 100;

  await ensureUserWallet(effectiveUserId);

  const alreadyCredited = await UserWallet.findOne({
    userId: effectiveUserId,
    'transactions.providerPaymentId': normalizedPaymentId,
  })
    .select('_id')
    .lean();

  if (!alreadyCredited) {
    const tx = {
      kind: 'credit',
      amount,
      title: 'Wallet Refilled',
      provider: 'razorpay',
      providerOrderId: normalizedOrderId,
      providerPaymentId: normalizedPaymentId,
    };

    await UserWallet.updateOne(
      { userId: effectiveUserId },
      {
        $inc: { balance: amount },
        $push: { transactions: { $each: [tx], $slice: -50 } },
      },
    );
  }

  const wallet = await UserWallet.findOne({ userId: effectiveUserId })
    .select('balance refundWallet transactions')
    .slice('transactions', -10)
    .lean();

  if (!wallet) {
    throw new ApiError(404, 'User not found');
  }

  return buildUserWalletPayload(wallet);
};



export const createPhonePeWalletTopupOrder = async (req, res) => {
  const amount = normalizeMoneyAmount(req.body?.amount);
  const { clientId, clientSecret, clientVersion, environment } = await resolvePhonePeCredentials();
  const userId = String(req.auth?.sub || '');
  const compactUserId = userId.replace(/[^a-zA-Z0-9]/g, '').slice(-8) || 'usr';
  const merchantTransactionId = `UWAL${Date.now()}${compactUserId}`.slice(0, 34);
  const frontendBaseUrl = getFrontendBaseUrl(req);
  const redirectUrl = `${frontendBaseUrl}/phonepe/status?flow=user-wallet&phonepe_txn=${encodeURIComponent(merchantTransactionId)}`;
  const user = userId ? await User.findById(userId).select('phone').lean() : null;
  logPaymentDiagnostic({
    provider: 'phonepe',
    scope: 'user-wallet',
    stage: 'create-order-start',
    merchantTransactionId,
    amountRupees: amount,
    request: buildPaymentRequestContext(req),
    metadata: {
      redirectUrl: summarizeCheckoutUrl(redirectUrl),
    },
  });
  const payload = await phonePeRequest({
    method: 'POST',
    path: '/checkout/v2/pay',
    body: {
      merchantOrderId: merchantTransactionId,
      amount: Math.round(amount * 100),
      expireAfter: 1200,
      paymentFlow: {
        type: 'PG_CHECKOUT',
        merchantUrls: {
          redirectUrl,
        },
        message: 'Wallet top-up',
      },
      prefillUserLoginDetails: normalizePhone(user?.phone || '')
        ? { phoneNumber: normalizePhone(user?.phone || '') }
        : undefined,
    },
    clientId,
    clientSecret,
    clientVersion,
    environment,
  });

  const checkoutUrl = payload?.redirectUrl || '';
  if (!checkoutUrl) {
    logPaymentDiagnostic({
      provider: 'phonepe',
      scope: 'user-wallet',
      stage: 'create-order-missing-checkout-url',
      level: 'error',
      merchantTransactionId,
      response: summarizePhonePePayload(payload || {}),
    });
    throw new ApiError(502, 'PhonePe payment URL was not returned');
  }

  logPaymentDiagnostic({
    provider: 'phonepe',
    scope: 'user-wallet',
    stage: 'create-order-success',
    merchantTransactionId,
    amountPaise: Math.round(amount * 100),
    checkoutUrl: summarizeCheckoutUrl(checkoutUrl),
    response: summarizePhonePePayload(payload || {}),
  });

  res.status(201).json({
    success: true,
    data: {
      gateway: 'phonepe',
      merchantTransactionId,
      amount: Math.round(amount * 100),
      currency: 'INR',
      checkoutUrl,
      method: payload?.data?.instrumentResponse?.redirectInfo?.method || 'GET',
    },
  });
};


export const verifyRazorpayWalletTopup = async (req, res) => {
  const wallet = await verifyAndApplyUserRazorpayWalletTopup({
    orderId: req.body?.razorpay_order_id,
    paymentId: req.body?.razorpay_payment_id,
    signature: req.body?.razorpay_signature,
    userId: req.auth?.sub,
  });

  res.status(201).json({
    success: true,
    data: wallet,
  });
};

export const handleUserRazorpayWalletTopupCallback = async (req, res) => {
  const frontendBaseUrl = getFrontendBaseUrl(req);
  const redirectUrl = new URL(`${frontendBaseUrl}/razorpay/status`);
  redirectUrl.searchParams.set('flow', 'user-wallet');

  try {
    const errorCode = String(
      req.body?.error?.code || req.body?.error?.reason || req.query?.error_code || '',
    ).trim();
    const errorDescription = String(
      req.body?.error?.description || req.query?.error_description || '',
    ).trim();

    if (errorCode || errorDescription) {
      redirectUrl.searchParams.set('status', 'failure');
      if (errorCode) {
        redirectUrl.searchParams.set('error_code', errorCode);
      }
      if (errorDescription) {
        redirectUrl.searchParams.set('error_description', errorDescription);
      }
      res.redirect(302, redirectUrl.toString());
      return;
    }

    await verifyAndApplyUserRazorpayWalletTopup({
      orderId: req.body?.razorpay_order_id || req.query?.razorpay_order_id,
      paymentId: req.body?.razorpay_payment_id || req.query?.razorpay_payment_id,
      signature: req.body?.razorpay_signature || req.query?.razorpay_signature,
    });

    redirectUrl.searchParams.set('status', 'success');
  } catch (error) {
    redirectUrl.searchParams.set('status', 'failure');
    redirectUrl.searchParams.set(
      'error_description',
      String(error?.message || 'Payment verification failed.'),
    );
  }

  res.redirect(302, redirectUrl.toString());
};

export const verifyPhonePeWalletTopup = async (req, res) => {
  const merchantTransactionId = toCleanString(
    req.params?.merchantTransactionId || req.query?.merchantTransactionId || req.query?.transactionId,
  );

  if (!merchantTransactionId) {
    throw new ApiError(400, 'merchantTransactionId is required');
  }

  logPaymentDiagnostic({
    provider: 'phonepe',
    scope: 'user-wallet',
    stage: 'verify-start',
    merchantTransactionId,
    request: buildPaymentRequestContext(req),
  });

  const { clientId, clientSecret, clientVersion, environment } = await resolvePhonePeCredentials();
  const payload = await phonePeRequest({
    method: 'GET',
    path: `/checkout/v2/order/${encodeURIComponent(merchantTransactionId)}/status?details=false`,
    clientId,
    clientSecret,
    clientVersion,
    environment,
  });

  const paymentDetails = Array.isArray(payload?.paymentDetails) ? payload.paymentDetails : [];
  const latestPayment = paymentDetails[0] || {};
  const paymentState = String(payload?.state || latestPayment?.state || '').trim().toUpperCase();
  const paymentId = toCleanString(latestPayment?.transactionId || latestPayment?.paymentTransactionId || merchantTransactionId);
  const amount = Math.round(Number(payload?.amount || latestPayment?.amount || 0)) / 100;
  const userId = req.auth?.sub;

  logPaymentDiagnostic({
    provider: 'phonepe',
    scope: 'user-wallet',
    stage: 'verify-response',
    merchantTransactionId,
    userId,
    paymentState,
    paymentId,
    amountRupees: amount,
    response: summarizePhonePePayload(payload || {}),
  });

  if (paymentState === 'COMPLETED') {
    await ensureUserWallet(userId);

    const alreadyCredited = await UserWallet.findOne({
      userId,
      $or: [
        { 'transactions.providerPaymentId': paymentId },
        { 'transactions.providerOrderId': merchantTransactionId },
      ],
    })
      .select('_id')
      .lean();

    if (!alreadyCredited) {
      const tx = {
        kind: 'credit',
        amount,
        title: 'Wallet Refilled',
        provider: 'phonepe',
        providerOrderId: merchantTransactionId,
        providerPaymentId: paymentId,
      };

      await UserWallet.updateOne(
        { userId },
        {
          $inc: { balance: amount },
          $push: { transactions: { $each: [tx], $slice: -50 } },
        },
      );
    }

    const wallet = await UserWallet.findOne({ userId })
      .select('balance refundWallet transactions')
      .slice('transactions', -10)
      .lean();

    logPaymentDiagnostic({
      provider: 'phonepe',
      scope: 'user-wallet',
      stage: 'verify-paid',
      merchantTransactionId,
      userId,
      paymentId,
      amountRupees: amount,
      alreadyCredited: Boolean(alreadyCredited),
      walletBalance: Number(wallet?.balance || 0),
    });

    res.json({
      success: true,
      data: {
        status: 'paid',
        gateway: 'phonepe',
        merchantTransactionId,
        transactionId: paymentId,
        wallet: buildUserWalletPayload(wallet),
      },
    });
    return;
  }

  if (paymentState === 'PENDING') {
    logPaymentDiagnostic({
      provider: 'phonepe',
      scope: 'user-wallet',
      stage: 'verify-pending',
      merchantTransactionId,
      userId,
      paymentId,
      amountRupees: amount,
    });
    res.json({
      success: true,
      data: {
        status: 'pending',
        gateway: 'phonepe',
        merchantTransactionId,
        transactionId: paymentId,
      },
      message: payload?.message || 'PhonePe payment is still pending',
    });
    return;
  }

  logPaymentDiagnostic({
    provider: 'phonepe',
    scope: 'user-wallet',
    stage: 'verify-failed',
    level: 'warn',
    merchantTransactionId,
    userId,
    paymentId,
    paymentState,
    amountRupees: amount,
    code: payload?.code || latestPayment?.responseCode || '',
    providerMessage:
      payload?.message ||
      latestPayment?.responseCodeDescription ||
      latestPayment?.detailedErrorCode ||
      '',
    response: summarizePhonePePayload(payload || {}),
  });
  const providerCode = payload?.code || latestPayment?.responseCode || '';
  const providerMessage =
    payload?.message ||
    latestPayment?.responseCodeDescription ||
    latestPayment?.detailedErrorCode ||
    'PhonePe payment was not completed';
  res.json({
    success: true,
    data: {
      status: 'failed',
      gateway: 'phonepe',
      merchantTransactionId,
      transactionId: paymentId,
      code: providerCode,
      state: paymentState,
      providerMessage,
    },
    message: providerMessage,
  });
};


















/// The rider's catalog is one row per vehicle, chosen the way the fare is.
///
/// Mirrors the cascade in `resolveSetPriceForRide`: a tariff for this exact
/// zone wins, then one for the zone's service location, then a global one.
/// Ranking here rather than querying per vehicle keeps this a single read.
///
/// A row carrying its own zone can only match that zone. Otherwise a tariff
/// written for Mysuru would price a Bangalore trip merely because both sit in
/// the same service location.
const pickTariffPerVehicle = (rows, zoneId, serviceLocationId, transportType) => {
  // Zone precedence, mirroring the cascade in `resolveSetPriceForRide`. A row
  // carrying its own zone can only apply to that zone: otherwise a tariff
  // written for Mysuru would price a Bangalore trip merely because the two
  // share a service location.
  const zoneRank = (row) => {
    if (zoneId && row.zone_id === zoneId) return 0;
    if (serviceLocationId && !row.zone_id && row.service_location_id === serviceLocationId) return 1;
    if (!row.zone_id) return 2;
    return null;
  };

  const best = new Map();

  for (const row of rows) {
    if (!row.type_id) continue;
    if (row.status && row.status !== 'active') continue;
    if (row.active === 0) continue;

    // Transport type narrows the catalog only when the caller names one. Rides
    // and parcels read the same endpoint, so filtering to taxi by default would
    // strip every parcel vehicle out of the delivery screen.
    let transportRank = 0;
    if (transportType) {
      if (row.transport_type === transportType) transportRank = 0;
      else if (row.transport_type === 'both') transportRank = 1;
      else continue;
    }

    const zoneScore = zoneRank(row);
    if (zoneScore === null) continue;

    // One tariff per vehicle. With no transport type named, a vehicle offered
    // for both rides and parcels keeps a row for each, because the two are
    // priced separately.
    const key = transportType ? row.type_id : `${row.type_id}:${row.transport_type}`;
    const score = zoneScore * 2 + transportRank;
    const incumbent = best.get(key);
    if (!incumbent || score < incumbent.score) best.set(key, { score, row });
  }

  return [...best.values()].map((entry) => entry.row);
};

/// Who is asking for a price, for counting distinct riders in surge demand.
/// The route is public, so the token is read if present but never required.
const surgeRequester = (req) => {
  const [, token] = String(req.headers.authorization || '').split(' ');
  if (token) {
    try {
      const payload = verifyAccessToken(token);
      if (payload?.sub) return `u:${payload.sub}`;
    } catch {
      // Expired or foreign token: fall back to the address.
    }
  }
  return `ip:${getRequestClientIp(req)}`;
};

/// Tariff catalog for the rider apps.
///
/// Two things separate this from the admin listing, and both were mispricing
/// every quote in the app:
///
///   - It is never paginated. The admin default of ten rows truncated a
///     sixteen-row catalog, so six vehicle types arrived with no tariff at all
///     and the app quoted them at an unrelated vehicle's rate.
///   - It is scoped to one zone. The app takes the first row matching a
///     vehicle, so returning every zone's rows let whichever zone was edited
///     last price the whole country - a Bangalore rider was quoted Indore's
///     tariff and then charged Bangalore's.
///
/// Pass the pickup as `lat`/`lng` (or a `zone_id` outright) to get the tariffs
/// that trip will actually be billed at. Callers that send neither still get
/// the full unscoped list, so older app builds keep working.
/**
 * Every set-price row matching a query, across pages.
 *
 * listSetPrices returns 10 rows unless asked for more. A zone with more rows
 * than that - Bangalore has 16, because several vehicles carry an old and a
 * new row - lost the rest, so some vehicles' city prices were never read and
 * the generic no-zone row priced them instead.
 */
const listAllSetPrices = async (args, options) => {
  const rows = [];
  for (let page = 1; page <= 20; page += 1) {
    const result = await listSetPrices({ ...args, page, limit: 100 }, null, options);
    const batch = result.results || [];
    rows.push(...batch);
    if (batch.length < 100) break;
  }
  return rows;
};

/**
 * The normal (un-surged) ride tariff per vehicle at a point, picked exactly as
 * a rider's quote picks it - same zone lookup, same no-zone fallback, same
 * ranking.
 *
 * For the driver surge map's "₹194 for 5 km, normally ₹149". Unlike
 * getSetPrices it records nothing: a driver looking at the map must never be
 * counted as a rider asking for a price, or looking would raise the surge.
 */
export const getTariffsAt = async ({ lat, lng, transportType = null } = {}) => {
  const latitude = Number(lat);
  const longitude = Number(lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return { zone: null, tariffs: [] };

  const zone = await findZoneByPickup([longitude, latitude]);
  const zoneId = zone ? String(zone._id) : null;
  if (!zoneId) return { zone: null, tariffs: [] };

  const [zoneRows, fallback] = await Promise.all([
    listAllSetPrices({ scope: 'ride', zone_id: zoneId }, { hikeMultiplier: 1 }),
    listAllSetPrices({ scope: 'ride', zone_id: 'none' }, { hikeMultiplier: 1 }),
  ]);
  const rows = [...zoneRows, ...fallback];
  const serviceLocationId = zone?.service_location_id
    ? String(zone.service_location_id._id || zone.service_location_id)
    : null;

  return { zone, tariffs: pickTariffPerVehicle(rows, zoneId, serviceLocationId, transportType) };
};

export const getSetPrices = asyncHandler(async (req, res) => {
  const query = { ...(req.query || {}) };
  const latitude = Number(query.lat ?? query.latitude);
  const longitude = Number(query.lng ?? query.longitude);
  const transportType = String(query.transport_type || '').trim().toLowerCase() || null;

  // A catalog, not a browsable table: a client that receives only part of it
  // cannot price the vehicles it is already showing.
  if (!query.limit && !query.per_page) {
    query.limit = 100;
  }

  let zone = null;
  const requestedZoneId = String(query.zone_id || '').trim();

  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    zone = await findZoneByPickup([longitude, latitude]);
  }

  delete query.zone_id;
  // Matched exactly by the listing, which would discard every row marked
  // 'both'; ranked here instead.
  delete query.transport_type;
  delete query.lat;
  delete query.lng;
  delete query.latitude;
  delete query.longitude;

  const zoneId = zone ? String(zone._id) : (requestedZoneId || null);

  // No location sent, so no zone to rank for. Most requests to this endpoint
  // arrive like this - older app builds and screens that ask before GPS is
  // ready - and those apps choose the price themselves from the whole table.
  // They always received the whole table; returning only the no-zone rows
  // instead left them with a single vehicle, and Bengaluru riders with no
  // prices. Every page is fetched, so the listing's hundred-row cut-off cannot
  // silently drop the oldest cities' rows either.
  if (!zoneId) {
    const firstPage = await listSetPrices({ ...query, page: 1, limit: 100 }, null);
    const lastPage = Number(firstPage.paginator?.last_page || 1);
    let allRows = [...(firstPage.results || [])];
    for (let page = 2; page <= lastPage; page += 1) {
      const nextPage = await listSetPrices({ ...query, page, limit: 100 }, null);
      allRows = allRows.concat(nextPage.results || []);
    }
    res.status(200).json({ success: true, ...firstPage, results: allRows });
    return;
  }

  // Only the rows the cascade below can use: this zone's, and the no-zone
  // fallbacks. It used to ask for every row in every zone and let the ranking
  // discard the rest - but the listing sorts newest first and cuts at a
  // hundred, so once the table passed a hundred rows, adding zones pushed the
  // oldest ones off the page. Seeding Karnataka, Bidar and Hyderabad took
  // Bengaluru from twelve vehicles to three. Fetched this way the count of
  // zones no longer matters.
  // Every located quote is a rider wanting a ride here: it is the demand the
  // automatic surge measures, and the pickup's hexagon sets its multiplier.
  let surge = { multiplier: 1, ends_at: null, hex: null, profiles: {} };
  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    recordSurgeDemand({ lat: latitude, lng: longitude, requester: surgeRequester(req) })
      .catch((error) => console.error('Surge demand not recorded', error.message));
    surge = await getSurgeAt(latitude, longitude).catch(() => surge);
  }
  // Surge is set per vehicle type: each row is priced with its own vehicle's.
  const surgeProfiles = await getSurgeProfiles();
  const multiplierForVehicle = (vehicleTypeId) => surgeForVehicle(surge, surgeProfiles, vehicleTypeId).multiplier;

  const [zoneRows, fallback] = await Promise.all([
    listSetPrices({ ...query, zone_id: zoneId }, null, { multiplierForVehicle }),
    listSetPrices({ ...query, zone_id: 'none' }, null, { multiplierForVehicle }),
  ]);
  const data = { ...zoneRows, results: [...(zoneRows.results || []), ...(fallback.results || [])] };

  const serviceLocationId = zone?.service_location_id
    ? String(zone.service_location_id._id || zone.service_location_id)
    : null;

  const results = pickTariffPerVehicle(data.results, zoneId, serviceLocationId, transportType);

  // Each vehicle's surge, for a badge on that vehicle alone. The top-level
  // multiplier is the highest of them, so an app that shows one badge for the
  // whole list never hides a surge a rider would pay.
  const byVehicle = {};
  for (const row of results) {
    const id = String(row.type_id || row.vehicle_type?._id || row.vehicle_type || '');
    if (!id || byVehicle[id]) continue;
    const vehicleSurge = surgeForVehicle(surge, surgeProfiles, id);
    if (vehicleSurge.multiplier > 1) byVehicle[id] = vehicleSurge;
  }
  const highest = Object.values(byVehicle).reduce(
    (best, item) => (item.multiplier > best.multiplier ? item : best),
    { multiplier: 1, ends_at: null },
  );

  res.status(200).json({
    success: true,
    ...data,
    results,
    zone_id: zoneId,
    zone_name: zone?.name || null,
    price_hike_multiplier: highest.multiplier,
    // For a "1.10x surge" label and its countdown in the apps. Each row's own
    // price_hike_multiplier is the one it was priced with.
    surge: {
      multiplier: highest.multiplier,
      source: highest.multiplier > 1 ? 'automatic' : 'none',
      ends_at: highest.ends_at,
      by_vehicle: byVehicle,
    },
  });
});

/// Reads a "lat,lng" query value into GeoJSON [lng, lat] order.
const parseLatLng = (raw) => {
  const parts = String(raw || '').split(',');
  if (parts.length !== 2) return null;
  const latitude = Number(parts[0].trim());
  const longitude = Number(parts[1].trim());
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return [longitude, latitude];
};

/// Road route between two points, for the apps' maps.
///
/// Both apps used to call the public OSRM demo server directly. It is
/// unauthenticated, rate-limited, and its usage policy forbids production
/// traffic - and when it throttled, the rider app fell back to drawing a
/// synthetic L-shaped path that follows no road at all. Rider and driver also
/// fetched independently, so they could draw different routes for one trip.
///
/// Serving it here gives one provider, the account's own Directions key, a
/// shared cache, and the same polyline for everyone. Authenticated because
/// each miss costs money.
export const getRoute = asyncHandler(async (req, res) => {
  const origin = parseLatLng(req.query.origin);
  const destination = parseLatLng(req.query.destination);

  if (!origin || !destination) {
    throw new ApiError(400, 'origin and destination are required, each as "lat,lng"');
  }

  const stops = String(req.query.waypoints || '')
    .split('|')
    .filter(Boolean)
    .map(parseLatLng)
    .filter(Boolean)
    .slice(0, 8);

  // Shared with parcel pricing, so a delivery's route line and its fare come
  // from one lookup. A failed lookup is no longer cached for five minutes.
  const route = await resolveRouteCached({ origin, destination, stops });

  if (!route?.polyline) {
    // 503, not 502: both providers being unreachable is a temporary condition
    // and the caller should keep whatever line it already has rather than
    // treating this as a permanent failure.
    throw new ApiError(503, 'No route provider is reachable right now');
  }

  res.status(200).json({ success: true, data: route });
});

export const getZones = asyncHandler(async (req, res) => {
  const results = await listZones(null);
  res.status(200).json({ success: true, results });
});

/**
 * Public booking enquiry from the marketing site. Unauthenticated on purpose:
 * the website form is a lead capture, not a signed-in booking flow.
 */
export const submitWebsiteBooking = async (req, res) => {
  const data = await createWebsiteBookingRequest(req.body);

  res.status(201).json({
    success: true,
    data: {
      message: 'Booking request received. Our team will call you shortly.',
      ...data,
    },
  });
};

/// What kind of trip a pickup and drop make - city, airport, outstation or
/// unserviceable - and so which module's vehicles the rider is offered. Takes
/// `pickup` and `drop` as "lat,lng".
export const getTripCategory = asyncHandler(async (req, res) => {
  const pickup = parseLatLng(req.query.pickup);
  const drop = parseLatLng(req.query.drop);
  if (!pickup || !drop) {
    res.status(400).json({ success: false, message: 'pickup and drop are required as "lat,lng"' });
    return;
  }
  res.status(200).json({ success: true, data: await classifyTrip({ pickup, drop }) });
});
