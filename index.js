import express from 'express';
import cors from 'cors';
import { MongoClient } from 'mongodb';
import 'dotenv/config';

const app = express();
const port = process.env.PORT || 5000;
const dbName = process.env.MONGODB_DATABASE || process.env.DB_NAME || 'fixoraClientDb';
const username = process.env.DB_USER;
const password = process.env.DB_PASSWORD;
const hosts = process.env.DB_HOSTS ||
  'ac-wozfpib-shard-00-00.bxn8etn.mongodb.net:27017,ac-wozfpib-shard-00-01.bxn8etn.mongodb.net:27017,ac-wozfpib-shard-00-02.bxn8etn.mongodb.net:27017';
const replicaSet = process.env.DB_REPLICA_SET || 'atlas-sgmdwx-shard-0';
const options = new URLSearchParams({
  ssl: process.env.DB_SSL || 'true',
  replicaSet,
  authSource: process.env.DB_AUTH_SOURCE || 'admin',
  retryWrites: 'true',
  w: 'majority',
  appName: 'FixoraServer',
});

if (!process.env.MONGODB_URI && (!username || !password)) {
  throw new Error('Set MONGODB_URI or both DB_USER and DB_PASSWORD in fixora-server/.env');
}

// Match the client's direct replica-set URI to avoid an SRV DNS lookup.
const mongoUri = process.env.MONGODB_URI ||
  `mongodb://${encodeURIComponent(username || '')}:${encodeURIComponent(password || '')}@${hosts}/${encodeURIComponent(dbName)}?${options}`;
const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 10000 });

app.use(express.json());
app.use(cors());

export async function connectToMongoDB() {
  await client.connect();
  await client.db(dbName).command({ ping: 1 });
  console.log('MongoDB connection established.');
  return client;
}

const connectedClient = await connectToMongoDB();
const database = connectedClient.db("fixoraClientDb");

const usersCollection = database.collection("user");
const servicesCollection = database.collection("service");

app.get('/users', async (req, res) => {
  try {
    const users = await usersCollection.find({}).toArray();
    res.status(200).json(users);
  }
    catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

app.get('/services', async (req, res) => {
  try {
    const service = req.body;
    const services = await servicesCollection.insertOne(service);
    res.send(services);
  } catch (error) {   
    console.error('Error fetching services:', error); 
    res.status(500).json({ message: 'Internal server error' });
  }
});

app.get('/', (req, res) => {
  res.send('Hello World!');
});

app.listen(port, () => {
  console.log(`Fixora API listening on port ${port}`);
});

export default app;