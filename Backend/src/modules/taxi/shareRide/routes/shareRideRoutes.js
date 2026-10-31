import { Router } from 'express';
import { authenticate } from '../../middlewares/authMiddleware.js';
import { rideCreationRateLimit, routeRateLimit } from '../../middlewares/rateLimitMiddleware.js';
import * as c from '../controllers/shareRideController.js';

// Share Ride routes for all four actors in one place. Absolute paths, so this
// router is mounted at the taxi root, ahead of the module routers. Admin routes
// are GET only: the admin watches car pooling, it does not run it.
export const shareRideRouter = Router();

const user = authenticate(['user']);
const driver = authenticate(['driver']);
const owner = authenticate(['owner']);
const admin = authenticate(['admin']);

// rider
// A quote asks the routing service for the distance, which is billed per call.
shareRideRouter.post('/users/share-rides/quote', user, routeRateLimit, c.quote);
shareRideRouter.post('/users/share-rides', user, rideCreationRateLimit, c.createRide);
shareRideRouter.get('/users/share-rides', user, c.myRides);
shareRideRouter.get('/users/share-rides/:id', user, c.myRide);
shareRideRouter.post('/users/share-rides/:id/cancel', user, c.cancelMyRide);

// driver
shareRideRouter.get('/drivers/share/status', driver, c.driverStatus);
shareRideRouter.get('/drivers/share/requests', driver, c.driverRequests);
shareRideRouter.post('/drivers/share/requests/:rideId/accept', driver, c.driverAccept);
shareRideRouter.post('/drivers/share/rides/:rideId/pickup', driver, c.driverPickup);
shareRideRouter.post('/drivers/share/rides/:rideId/complete', driver, c.driverComplete);
shareRideRouter.post('/drivers/share/rides/:rideId/release', driver, c.driverRelease);
shareRideRouter.get('/drivers/share/trip', driver, c.driverTrip);
shareRideRouter.post('/drivers/share/trips/:id/complete', driver, c.driverCompleteTrip);
shareRideRouter.post('/drivers/share/trips/:id/cancel', driver, c.driverCancelTrip);
shareRideRouter.get('/drivers/share/earnings', driver, c.driverEarnings);

// owner
shareRideRouter.get('/drivers/fleet/share/overview', owner, c.ownerOverview);
shareRideRouter.get('/drivers/fleet/share/trips', owner, c.ownerTrips);
shareRideRouter.get('/drivers/fleet/share/rides', owner, c.ownerRides);
shareRideRouter.post('/drivers/fleet/share/trips', owner, c.ownerCreateTrip);
shareRideRouter.post('/drivers/fleet/share/trips/:id/cancel', owner, c.ownerCancelTrip);
shareRideRouter.patch('/drivers/fleet/share/drivers/:driverId', owner, c.ownerSetDriver);

// admin (read-only)
shareRideRouter.get('/admin/share-rides/overview', admin, c.adminOverview);
shareRideRouter.get('/admin/share-rides/trips', admin, c.adminTrips);
shareRideRouter.get('/admin/share-rides/rides', admin, c.adminRides);
