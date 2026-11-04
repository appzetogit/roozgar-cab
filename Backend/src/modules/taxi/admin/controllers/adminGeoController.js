import { asyncHandler } from '../../../../utils/asyncHandler.js';
import { getHeatmapPoints, getLiveMap } from '../services/adminGeoService.js';

export const heatmapPoints = asyncHandler(async (req, res) =>
  res.json({ success: true, data: await getHeatmapPoints(req.query, req.auth?.admin) }),
);
export const liveMap = asyncHandler(async (req, res) =>
  res.json({ success: true, data: await getLiveMap(req.auth?.admin) }),
);
