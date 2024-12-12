import loadEnvVariables from './utils/envHelper.js';
import cookieParser from 'cookie-parser';
import bodyParser from 'body-parser';
import express from "express";
import cors from "cors";
import logger from 'morgan';
import initializeFirebase from './lib/firebase/initializeFirebase.js';
import logErrors from './utils/logErrors.js';
import router from './utils/router.js';
import dbConnect from './database/mongooseConnector.js';
import mongoSanitize from 'express-mongo-sanitize';
import Redis from 'ioredis';
import helmet from 'helmet';
import DOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';
import validator from 'validator';
import appVersionValidator from '../src/middlewares/appVersionValidator.js';

const app = express();
global.redisCache = new Redis(process.env.BHASHINI_REDIS_PORT, process.env.BHASHINI_REDIS_HOST);
const window = new JSDOM('').window;
const purify = DOMPurify(window);

loadEnvVariables();
initializeFirebase();

app.use(cookieParser());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
app.use(logger('combined'));

// Compulsory CORS configuration
app.use(cors({ origin: true, credentials: true }));

// Enhanced CORS Configuration
if (!process.env.CORS_WHITELIST_URLS) {
    throw new Error('CORS_WHITELIST_URLS environment variable is not set');
}

const whitelist = process.env.CORS_WHITELIST_URLS.split(',').map(url => url.trim());
console.log("CORS Whitelist: ", whitelist);

const corsOptions = {
    origin: function (origin, callback) {
        // Allow requests with no origin (like mobile apps or curl requests)
        if (!origin) {
            return callback(null, true);
        }
        if (whitelist.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: [
        'Origin',
        'X-Requested-With',
        'Content-Type',
        'Accept',
        'Authorization',
        'Access-Control-Allow-Origin',
        'Access-Control-Allow-Headers',
        'Access-Control-Allow-Methods'
    ],
    credentials: true,
    maxAge: 86400, // 24 hours
    preflightContinue: false,
    optionsSuccessStatus: 204
};

// Apply enhanced CORS middleware globally
app.use(cors(corsOptions));

// Additional CORS headers middleware
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', req.header('Origin') || '*');
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Allow-Methods', 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    // Handle preflight requests
    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }
    next();
});

// Security middleware to block disallowed origins
app.use((req, res, next) => {
    const origin = req.header('Origin');
    if (origin && !whitelist.includes(origin)) {
        console.log(`Blocked request from unauthorized origin: ${origin}`);
        return res.status(403).json({
            error: 'CORS policy does not allow access from this origin.',
            origin: origin
        });
    }
    next();
});

// Apply routes with version validator
app.use('/clientApis', appVersionValidator(), router);
app.use(helmet.xssFilter());

// Custom sanitize functions
function customEscape(value) {
    if (typeof value === 'string') {
        if (validator.isURL(value, { require_protocol: true })) {
            return value;
        }
        return value;
    }
    return value;
}

function sanitize(input) {
    if (typeof input === 'string') {
        input = validator.trim(input);
        input = customEscape(input);
        return purify.sanitize(input);
    } else if (typeof input === 'object' && input !== null) {
        if (Array.isArray(input)) {
            return input.map(sanitize);
        } else {
            for (let key in input) {
                if (input.hasOwnProperty(key)) {
                    input[key] = sanitize(input[key]);
                }
            }
            return input;
        }
    } else {
        return input;
    }
}

app.use((req, res, next) => {
    req.body = sanitize(req.body);
    next();
});

app.use(mongoSanitize({
    onSanitize: ({ req, key }) => {
        console.warn(`This request[${key}] is sanitized`, req);
    },
}));

app.use(logErrors);

app.get("*", (req, res) => {
    res.status(404).send("API NOT FOUND");
});

const port = process.env.PORT || 8080;

dbConnect()
    .then((db) => {
        console.log("Database connection successful");
        app.listen(port, () => {
            console.log(`Listening on port ${port}`);
        });
    })
    .catch((error) => {
        console.log("Error connecting to the database", error);
        return;
    });

