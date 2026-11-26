import crypto from "node:crypto";
import express from "express";
import cors from "cors";
import { MongoClient, ObjectId } from "mongodb";
import "dotenv/config";

const app = express();
const api = express.Router();
const port = process.env.PORT || 8000;
const dbName = process.env.MONGODB_DATABASE || process.env.DB_NAME || "fixoraClientDb";
const username = process.env.DB_USER;
const password = process.env.DB_PASSWORD;
const hosts = process.env.DB_HOSTS ||
  "ac-wozfpib-shard-00-00.bxn8etn.mongodb.net:27017,ac-wozfpib-shard-00-01.bxn8etn.mongodb.net:27017,ac-wozfpib-shard-00-02.bxn8etn.mongodb.net:27017";
const replicaSet = process.env.DB_REPLICA_SET || "atlas-sgmdwx-shard-0";
const mongoOptions = new URLSearchParams({
  ssl: process.env.DB_SSL || "true",
  replicaSet,
  authSource: process.env.DB_AUTH_SOURCE || "admin",
  retryWrites: "true",
  w: "majority",
  appName: "FixoraServer",
});

if (!process.env.MONGODB_URI && (!username || !password)) {
  throw new Error(
    "Set MONGODB_URI or both DB_USER and DB_PASSWORD in fixora-server/.env",
  );
}

const mongoUri =
  process.env.MONGODB_URI ||
  `mongodb://${encodeURIComponent(username || "")}:${encodeURIComponent(password || "")}@${hosts}/${encodeURIComponent(dbName)}?${mongoOptions}`;
const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 10000 });

app.use(express.json({ limit: "1mb" }));
app.use(cors());

export async function connectToMongoDB() {
  await client.connect();
  await client.db(dbName).command({ ping: 1 });
  console.log("MongoDB connection established.");
  return client;
}

const connectedClient = await connectToMongoDB();
const database = connectedClient.db(dbName);
const usersCollection = database.collection("user");
const servicesCollection = database.collection("services");
const bookingsCollection = database.collection("bookings");
const paymentsCollection = database.collection("payments");

function authenticateInternalRequest(req, res, next) {
  const expectedKey = process.env.FIXORA_SERVER_API_KEY;
  if (!expectedKey) {
    return res.status(503).json({ message: "The Fixora API is not configured." });
  }

  const providedKey = req.get("x-fixora-api-key") || "";
  const expected = Buffer.from(expectedKey);
  const provided = Buffer.from(providedKey);
  if (
    expected.length !== provided.length ||
    !crypto.timingSafeEqual(expected, provided)
  ) {
    return res.status(401).json({ message: "Unauthorized API request." });
  }

  const encodedUser = req.get("x-fixora-user");
  if (encodedUser) {
    try {
      const user = JSON.parse(Buffer.from(encodedUser, "base64url").toString("utf8"));
      if (
        typeof user.id !== "string" ||
        typeof user.email !== "string" ||
        typeof user.name !== "string" ||
        !["customer", "technician", "admin"].includes(user.role)
      ) {
        return res.status(401).json({ message: "Invalid authenticated user." });
      }
      req.fixoraUser = user;
    } catch {
      return res.status(401).json({ message: "Invalid authenticated user." });
    }
  } else {
    req.fixoraUser = null;
  }

  next();
}

api.use(authenticateInternalRequest);
app.use("/api", api);
app.use("/users", authenticateInternalRequest);

function requireRoles(req, res, roles) {
  if (!req.fixoraUser) {
    res.status(401).json({ message: "Sign in to continue." });
    return false;
  }
  if (roles && !roles.includes(req.fixoraUser.role)) {
    res.status(403).json({ message: "You do not have permission." });
    return false;
  }
  return true;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidObjectId(value) {
  return (
    typeof value === "string" &&
    ObjectId.isValid(value) &&
    new ObjectId(value).toString() === value
  );
}

function serializeDocument(document) {
  const id = document._id?.toString();
  return { ...document, _id: id, id };
}

function getJsonObject(req, res) {
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    res.status(400).json({ message: "Request body must be an object." });
    return null;
  }
  return body;
}

function serviceFieldsAreValid(body) {
  return [
    "title",
    "category",
    "description",
    "estimatedDuration",
    "serviceMode",
    "serviceArea",
    "image",
  ].every((field) => isNonEmptyString(body[field]));
}

function getServiceFields(body) {
  return Object.fromEntries(
    [
      "title",
      "category",
      "description",
      "estimatedDuration",
      "serviceMode",
      "serviceArea",
      "image",
    ].map((field) => [field, body[field].trim()]),
  );
}

async function getActivityDays(collection, filter) {
  const now = new Date();
  const firstDay = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 6),
  );
  const counts = await collection
    .aggregate([
      { $match: { ...filter, createdAt: { $gte: firstDay } } },
      {
        $group: {
          _id: {
            $dateToString: { format: "%Y-%m-%d", date: "$createdAt" },
          },
          value: { $sum: 1 },
        },
      },
    ])
    .toArray();
  const countsByDay = new Map(counts.map((count) => [count._id, count.value]));
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (6 - index)),
    );
    const key = date.toISOString().slice(0, 10);
    return {
      label: date.toLocaleDateString("en", {
        weekday: "short",
        timeZone: "UTC",
      }),
      value: countsByDay.get(key) ?? 0,
    };
  });
}

api.get("/services", async (req, res) => {
  const includeUnavailable = req.query.includeUnavailable === "true";
  const filter = includeUnavailable
    ? { approvalStatus: "approved" }
    : { approvalStatus: "approved", isAvailable: true };
  const services = await servicesCollection
    .find(filter)
    .sort({ createdAt: -1 })
    .toArray();
  res.json({ services: services.map(serializeDocument) });
});

api.get("/services/:id", async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) {
    return res.status(404).json({ message: "Service not found." });
  }
  const service = await servicesCollection.findOne({
    _id: new ObjectId(id),
    approvalStatus: "approved",
    isAvailable: true,
  });
  if (!service) {
    return res.status(404).json({ message: "Service not found." });
  }

  const legacyTechnician = service.technician ?? {};
  const technicianEmail = service.technicianEmail ?? legacyTechnician.email;
  const technicianProfile =
    typeof technicianEmail === "string"
      ? await usersCollection.findOne(
          { email: technicianEmail },
          { projection: { name: 1, image: 1, area: 1, bio: 1 } },
        )
      : null;
  const technician = {
    id: legacyTechnician.id ?? technicianProfile?._id?.toString() ?? "",
    name:
      service.technicianName ??
      legacyTechnician.name ??
      technicianProfile?.name ??
      "Technician",
    photo: legacyTechnician.photo ?? technicianProfile?.image ?? "",
    area: legacyTechnician.area ?? technicianProfile?.area ?? "",
    bio: legacyTechnician.bio ?? technicianProfile?.bio ?? "",
  };
  res.json({ service: serializeDocument({ ...service, technician }) });
});

api.get("/dashboard/services", async (req, res) => {
  if (!requireRoles(req, res, ["technician", "admin"])) return;
  const filter = req.fixoraUser.role === "admin"
    ? {}
    : { technicianEmail: req.fixoraUser.email };
  const approvalStatus = req.query.approvalStatus;
  if (["pending", "approved", "rejected"].includes(approvalStatus)) {
    filter.approvalStatus = approvalStatus;
  }
  const services = await servicesCollection
    .find(filter)
    .sort({ approvalStatus: 1, createdAt: -1 })
    .toArray();
  res.json({ services: services.map(serializeDocument) });
});

api.post("/dashboard/services", async (req, res) => {
  if (!requireRoles(req, res, ["technician"])) return;
  const body = getJsonObject(req, res);
  if (!body) return;
  if (!serviceFieldsAreValid(body)) {
    return res.status(400).json({ message: "Complete all service fields." });
  }
  const basePrice = Number(body.basePrice ?? body.startingPrice);
  if (!Number.isFinite(basePrice) || basePrice <= 0) {
    return res.status(400).json({ message: "Enter a positive base price." });
  }

  const service = {
    ...getServiceFields(body),
    basePrice,
    approvalStatus: "pending",
    isAvailable: true,
    technicianName: req.fixoraUser.name,
    technicianEmail: req.fixoraUser.email,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const result = await servicesCollection.insertOne(service);
  res.status(201).json({
    service: serializeDocument({ ...service, _id: result.insertedId }),
  });
});

api.patch("/dashboard/services/:id", async (req, res) => {
  if (!requireRoles(req, res, ["technician", "admin"])) return;
  const { id } = req.params;
  if (!isValidObjectId(id)) {
    return res.status(404).json({ message: "Service not found." });
  }
  const body = getJsonObject(req, res);
  if (!body) return;
  const ownerFilter = req.fixoraUser.role === "admin"
    ? { _id: new ObjectId(id) }
    : { _id: new ObjectId(id), technicianEmail: req.fixoraUser.email };
  const service = await servicesCollection.findOne(ownerFilter);
  if (!service) {
    return res.status(404).json({ message: "Service not found." });
  }

  if (req.fixoraUser.role === "admin") {
    if (body.approvalStatus !== "approved" && body.approvalStatus !== "rejected") {
      return res.status(400).json({ message: "Choose approve or reject." });
    }
    await servicesCollection.updateOne(ownerFilter, {
      $set: { approvalStatus: body.approvalStatus, updatedAt: new Date() },
    });
    return res.json({ success: true });
  }

  if (typeof body.isAvailable === "boolean" && Object.keys(body).length === 1) {
    await servicesCollection.updateOne(ownerFilter, {
      $set: { isAvailable: body.isAvailable, updatedAt: new Date() },
    });
    return res.json({ success: true });
  }

  if (!serviceFieldsAreValid(body)) {
    return res.status(400).json({ message: "Complete all service fields." });
  }
  const basePrice = Number(body.basePrice ?? body.startingPrice);
  if (!Number.isFinite(basePrice) || basePrice <= 0) {
    return res.status(400).json({ message: "Enter a positive base price." });
  }
  await servicesCollection.updateOne(ownerFilter, {
    $set: {
      ...getServiceFields(body),
      basePrice,
      technicianName: req.fixoraUser.name,
      technicianEmail: req.fixoraUser.email,
      approvalStatus: "pending",
      updatedAt: new Date(),
    },
  });
  res.json({ success: true });
});

api.delete("/dashboard/services/:id", async (req, res) => {
  if (!requireRoles(req, res, ["technician"])) return;
  const { id } = req.params;
  if (!isValidObjectId(id)) {
    return res.status(404).json({ message: "Service not found." });
  }
  const result = await servicesCollection.deleteOne({
    _id: new ObjectId(id),
    technicianEmail: req.fixoraUser.email,
  });
  if (!result.deletedCount) {
    return res.status(404).json({ message: "Service not found." });
  }
  res.json({ success: true });
});

api.post("/bookings", async (req, res) => {
  if (!requireRoles(req, res, ["customer"])) return;
  const body = getJsonObject(req, res);
  if (!body) return;
  const customerPhone = body.customerPhone ?? body.phone;
  if (
    !isNonEmptyString(body.serviceId) ||
    !isNonEmptyString(customerPhone) ||
    !isNonEmptyString(body.address) ||
    !isNonEmptyString(body.preferredDate) ||
    !isNonEmptyString(body.problemDescription)
  ) {
    return res.status(400).json({ message: "Complete all booking fields." });
  }

  const serviceId = body.serviceId.trim();
  const preferredDateValue = body.preferredDate.trim();
  const problemDescription = body.problemDescription.trim();
  if (!isValidObjectId(serviceId)) {
    return res.status(400).json({ message: "Choose a valid service." });
  }
  if (problemDescription.length < 20) {
    return res.status(400).json({
      message: "Describe the problem in at least 20 characters.",
    });
  }
  const preferredDate = new Date(`${preferredDateValue}T00:00:00.000Z`);
  const today = new Date().toISOString().slice(0, 10);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(preferredDateValue) ||
    Number.isNaN(preferredDate.getTime()) ||
    preferredDate.toISOString().slice(0, 10) !== preferredDateValue ||
    preferredDateValue < today
  ) {
    return res.status(400).json({ message: "Choose today or a future date." });
  }

  const service = await servicesCollection.findOne({
    _id: new ObjectId(serviceId),
    approvalStatus: "approved",
    isAvailable: true,
  });
  if (!service) {
    return res.status(404).json({ message: "This service is no longer available." });
  }
  const duplicate = await bookingsCollection.findOne({
    $or: [
      { customerId: req.fixoraUser.id },
      { customerEmail: req.fixoraUser.email },
    ],
    serviceId,
    status: { $in: ["requested", "accepted", "in-progress"] },
  });
  if (duplicate) {
    return res.status(409).json({
      message: "You already have an active request for this service",
    });
  }
  const basePrice = Number(service.basePrice ?? service.startingPrice);
  if (!Number.isFinite(basePrice) || basePrice <= 0) {
    return res.status(400).json({ message: "The service has an invalid price." });
  }
  const technician = service.technician ?? {};
  const booking = {
    serviceId: service._id.toString(),
    serviceTitle: service.title,
    serviceImage: service.image ?? "",
    category: service.category ?? "",
    basePrice,
    technicianName: service.technicianName ?? technician.name ?? "",
    technicianEmail: service.technicianEmail ?? technician.email ?? "",
    customerId: req.fixoraUser.id,
    customerName: req.fixoraUser.name,
    customerEmail: req.fixoraUser.email,
    customerPhone: customerPhone.trim(),
    address: body.address.trim(),
    preferredDate,
    problemDescription,
    finalAmount: basePrice,
    status: "requested",
    paymentStatus: "unpaid",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const result = await bookingsCollection.insertOne(booking);
  res.status(201).json({
    booking: serializeDocument({ ...booking, _id: result.insertedId }),
  });
});

api.get("/dashboard/bookings", async (req, res) => {
  if (!requireRoles(req, res, ["customer"])) return;
  const bookings = await bookingsCollection
    .find({ customerEmail: req.fixoraUser.email })
    .sort({ createdAt: -1 })
    .toArray();
  res.json({ bookings: bookings.map(serializeDocument) });
});

api.patch("/dashboard/bookings/:id", async (req, res) => {
  if (!requireRoles(req, res, ["customer"])) return;
  const { id } = req.params;
  if (!isValidObjectId(id)) {
    return res.status(404).json({ message: "Booking not found." });
  }
  const result = await bookingsCollection.updateOne(
    {
      _id: new ObjectId(id),
      customerEmail: req.fixoraUser.email,
      status: "requested",
    },
    { $set: { status: "cancelled", updatedAt: new Date() } },
  );
  if (!result.matchedCount) {
    return res
      .status(409)
      .json({ message: "Only requested bookings can be cancelled." });
  }
  res.json({ success: true });
});

api.get("/dashboard/requests", async (req, res) => {
  if (!requireRoles(req, res, ["technician"])) return;
  const bookings = await bookingsCollection
    .find({ technicianEmail: req.fixoraUser.email })
    .sort({ createdAt: -1 })
    .toArray();
  res.json({ bookings: bookings.map(serializeDocument) });
});

api.patch("/dashboard/requests/:id", async (req, res) => {
  if (!requireRoles(req, res, ["technician"])) return;
  const { id } = req.params;
  if (!isValidObjectId(id)) {
    return res.status(404).json({ message: "Booking not found." });
  }
  const body = getJsonObject(req, res);
  if (!body) return;
  if (!isNonEmptyString(body.status)) {
    return res.status(400).json({ message: "Choose a valid next status." });
  }

  const transitions = {
    requested: ["accepted", "rejected"],
    accepted: ["in-progress"],
    "in-progress": ["completed"],
  };
  const booking = await bookingsCollection.findOne({
    _id: new ObjectId(id),
    technicianEmail: req.fixoraUser.email,
  });
  if (!booking) {
    return res.status(404).json({ message: "Booking not found." });
  }
  if (!transitions[booking.status]?.includes(body.status)) {
    return res
      .status(409)
      .json({ message: "That booking status change is not allowed." });
  }

  const update = { status: body.status, updatedAt: new Date() };
  if (body.status === "completed") {
    const finalAmount = Number(body.finalAmount ?? booking.basePrice);
    if (!Number.isFinite(finalAmount) || finalAmount <= 0) {
      return res.status(400).json({ message: "Enter a positive final amount." });
    }
    update.finalAmount = finalAmount;
  } else if (body.finalAmount !== undefined) {
    return res.status(400).json({
      message: "A final amount can only be set when completing a job.",
    });
  }

  const result = await bookingsCollection.updateOne(
    {
      _id: new ObjectId(id),
      technicianEmail: req.fixoraUser.email,
      status: booking.status,
    },
    { $set: update },
  );
  if (!result.matchedCount) {
    return res
      .status(409)
      .json({ message: "That booking status change is no longer available." });
  }
  res.json({ success: true });
});

api.get("/dashboard/admin/bookings", async (req, res) => {
  if (!requireRoles(req, res, ["admin"])) return;
  const status = req.query.status;
  const filter = [
    "requested",
    "accepted",
    "in-progress",
    "completed",
    "rejected",
    "cancelled",
  ].includes(status)
    ? { status }
    : {};
  const bookings = await bookingsCollection
    .find(filter)
    .sort({ createdAt: -1 })
    .toArray();
  res.json({ bookings: bookings.map(serializeDocument) });
});

api.get("/dashboard/payments", async (req, res) => {
  if (!requireRoles(req, res, ["customer", "admin"])) return;
  const filter = req.fixoraUser.role === "admin"
    ? {}
    : { customerEmail: req.fixoraUser.email };
  const payments = await paymentsCollection
    .find(filter)
    .sort({ paidAt: -1 })
    .toArray();
  res.json({ payments: payments.map(serializeDocument) });
});

api.post("/dashboard/bookings/:id/checkout", async (req, res) => {
  if (!requireRoles(req, res, ["customer"])) return;
  const { id } = req.params;
  if (!isValidObjectId(id)) {
    return res.status(404).json({ message: "Booking not found." });
  }
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    return res.status(503).json({
      message: "Online payment is not configured. Please contact support.",
    });
  }

  const booking = await bookingsCollection.findOne({
    _id: new ObjectId(id),
    customerEmail: req.fixoraUser.email,
    status: "completed",
    paymentStatus: "unpaid",
  });
  if (!booking) {
    return res
      .status(409)
      .json({ message: "Only completed, unpaid bookings can be paid." });
  }
  const amount = Number(booking.finalAmount ?? booking.basePrice);
  if (!Number.isFinite(amount) || amount <= 0) {
    return res
      .status(400)
      .json({ message: "This booking has an invalid payment amount." });
  }

  const clientUrl = req.get("x-fixora-client-url");
  let origin;
  try {
    origin = new URL(clientUrl).origin;
  } catch {
    return res.status(500).json({ message: "The client URL is not configured." });
  }
  const form = new URLSearchParams({
    mode: "payment",
    customer_email: req.fixoraUser.email,
    success_url: `${origin}/dashboard/customer/bookings?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/dashboard/customer/bookings?checkout=cancelled`,
    "line_items[0][price_data][currency]": "bdt",
    "line_items[0][price_data][unit_amount]": String(Math.round(amount * 100)),
    "line_items[0][price_data][product_data][name]": String(
      booking.serviceTitle ?? "Repair service",
    ),
    "line_items[0][quantity]": "1",
    "metadata[bookingId]": id,
    "metadata[customerId]": req.fixoraUser.id,
  });
  const stripeResponse = await fetch(
    "https://api.stripe.com/v1/checkout/sessions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Idempotency-Key": `fixora-booking-${id}`,
      },
      body: form,
    },
  );
  const result = await stripeResponse.json();
  if (!stripeResponse.ok || !result.url) {
    return res.status(502).json({
      message: result.error?.message ?? "Unable to start secure checkout.",
    });
  }
  res.json({ url: result.url });
});

api.post("/dashboard/bookings/confirm-payment", async (req, res) => {
  if (!requireRoles(req, res, ["customer"])) return;
  if (!process.env.STRIPE_SECRET_KEY) {
    return res
      .status(503)
      .json({ message: "Online payment is not configured." });
  }
  const body = getJsonObject(req, res);
  if (!body) return;
  if (!isNonEmptyString(body.sessionId)) {
    return res.status(400).json({ message: "Checkout session is required." });
  }

  const stripeResponse = await fetch(
    `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(body.sessionId)}`,
    { headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` } },
  );
  const checkout = await stripeResponse.json();
  if (!stripeResponse.ok) {
    return res.status(502).json({
      message: checkout.error?.message ?? "Unable to verify payment.",
    });
  }
  const bookingId = checkout.metadata?.bookingId;
  if (
    checkout.payment_status !== "paid" ||
    checkout.metadata?.customerId !== req.fixoraUser.id ||
    !isValidObjectId(bookingId)
  ) {
    return res.status(409).json({
      message: "This checkout session is not a completed payment for your account.",
    });
  }

  const booking = await bookingsCollection.findOne({
    _id: new ObjectId(bookingId),
    customerEmail: req.fixoraUser.email,
    status: "completed",
  });
  if (!booking) {
    return res.status(404).json({ message: "Booking not found." });
  }

  const paymentIntentId =
    typeof checkout.payment_intent === "string"
      ? checkout.payment_intent
      : checkout.payment_intent?.id ?? checkout.id;
  if (!paymentIntentId) {
    return res.status(502).json({ message: "Payment reference is missing." });
  }
  await paymentsCollection.updateOne(
    { transactionId: paymentIntentId },
    {
      $setOnInsert: {
        bookingId,
        customerId: req.fixoraUser.id,
        customerName: booking.customerName,
        customerEmail: req.fixoraUser.email,
        technicianName: booking.technicianName,
        technicianEmail: booking.technicianEmail,
        serviceTitle: booking.serviceTitle,
        amount: Number(checkout.amount_total ?? 0) / 100,
        currency: checkout.currency ?? "bdt",
        transactionId: paymentIntentId,
        paidAt: new Date(),
      },
    },
    { upsert: true },
  );
  await bookingsCollection.updateOne(
    { _id: new ObjectId(bookingId), customerEmail: req.fixoraUser.email },
    { $set: { paymentStatus: "paid", updatedAt: new Date() } },
  );
  res.json({ success: true });
});

api.get("/dashboard/summary", async (req, res) => {
  if (!requireRoles(req, res, ["customer", "technician", "admin"])) return;
  const user = req.fixoraUser;
  const bookings = bookingsCollection;
  if (user.role === "customer") {
    const filter = { customerEmail: user.email };
    const [total, active, completed, activity] = await Promise.all([
      bookings.countDocuments(filter),
      bookings.countDocuments({
        ...filter,
        status: { $in: ["requested", "accepted", "in-progress"] },
      }),
      bookings.countDocuments({ ...filter, status: "completed" }),
      getActivityDays(bookings, filter),
    ]);
    return res.json({
      stats: [
        { label: "Total Requests", value: total },
        { label: "Active Jobs", value: active },
        { label: "Completed Jobs", value: completed },
      ],
      activity,
    });
  }

  if (user.role === "technician") {
    const serviceFilter = { technicianEmail: user.email };
    const requestFilter = { technicianEmail: user.email, status: "requested" };
    const [totalServices, approvedServices, pendingRequests, activity] =
      await Promise.all([
        servicesCollection.countDocuments(serviceFilter),
        servicesCollection.countDocuments({
          ...serviceFilter,
          approvalStatus: "approved",
        }),
        bookings.countDocuments(requestFilter),
        getActivityDays(servicesCollection, serviceFilter),
      ]);
    return res.json({
      stats: [
        { label: "Total Services", value: totalServices },
        { label: "Approved Services", value: approvedServices },
        { label: "Pending Requests", value: pendingRequests },
      ],
      activity,
    });
  }

  const [totalUsers, totalTechnicians, pendingServices, activity] =
    await Promise.all([
      usersCollection.countDocuments({}),
      usersCollection.countDocuments({ role: "technician" }),
      servicesCollection.countDocuments({ approvalStatus: "pending" }),
      getActivityDays(bookings, {}),
    ]);
  res.json({
    stats: [
      { label: "Total Users", value: totalUsers },
      { label: "Total Technicians", value: totalTechnicians },
      { label: "Pending Services", value: pendingServices },
    ],
    activity,
  });
});

app.get("/users", async (_req, res) => {
  const users = await usersCollection.find({}).toArray();
  res.status(200).json(users);
});

app.get("/", (_req, res) => {
  res.send("Fixora API is running.");
});

app.use((error, _req, res, _next) => {
  console.error("Fixora API request failed:", error);
  if (error?.type === "entity.parse.failed") {
    return res.status(400).json({ message: "Request body must contain valid JSON." });
  }
  res.status(500).json({ message: "Internal server error." });
});

if (!process.env.VERCEL) {
  app.listen(port, () => {
    console.log(`Fixora API listening on port ${port}`);
  });
}

export default app;
