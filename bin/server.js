#!/usr/bin/env node

import { WebSocketServer } from 'ws'
import http from 'http'
import * as map from 'lib0/map'
import axios from 'axios' // Added axios for Laravel auth

const wsReadyStateConnecting = 0
const wsReadyStateOpen = 1
const wsReadyStateClosing = 2 // eslint-disable-line
const wsReadyStateClosed = 3 // eslint-disable-line

const pingTimeout = 30000

const port = process.env.PORT || 4444
const wss = new WebSocketServer({ noServer: true })

// const LARAVEL_AUTH_URL = 'http://webserver/api/verify-token' // for the local env
const LARAVEL_AUTH_URL = 'https://gomarketplan.io/api/verify-token';

const server = http.createServer((request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/plain' })
  response.end('okay')
})

/**
 * Map froms topic-name to set of subscribed clients.
 * @type {Map<string, Set<any>>}
 */
const topics = new Map()

/**
 * @param {any} conn
 * @param {object} message
 */
const send = (conn, message) => {
  if (conn.readyState !== wsReadyStateConnecting && conn.readyState !== wsReadyStateOpen) {
    conn.close()
  }
  try {
    conn.send(JSON.stringify(message))
  } catch (e) {
    conn.close()
  }
}

// Function to authenticate token with Laravel
const authenticateToken = async (token) => {
  try {
    const response = await axios.post(
      LARAVEL_AUTH_URL,
      {},
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return response.data.user_id; // Expecting Laravel to return user_id
  } catch (error) {
    console.error('Token authentication failed:', 
      // error.response?.data || error.message
    );
    return null;
  }
};

/**
 * Setup a new client
 * @param {any} conn
 */
const onconnection = conn => {
  /**
   * @type {Set<string>}
   */
  const subscribedTopics = new Set()
  let closed = false
  // Check if connection is still alive
  let pongReceived = true
  const pingInterval = setInterval(() => {
    if (!pongReceived) {
      conn.close()
      clearInterval(pingInterval)
    } else {
      pongReceived = false
      try {
        conn.ping()
      } catch (e) {
        conn.close()
      }
    }
  }, pingTimeout)
  conn.on('pong', () => {
    pongReceived = true
  })
  conn.on('close', () => {
    subscribedTopics.forEach(topicName => {
      const subs = topics.get(topicName) || new Set()
      subs.delete(conn)
      if (subs.size === 0) {
        topics.delete(topicName)
      }
    })
    subscribedTopics.clear()
    closed = true
  })
  conn.on('message', /** @param {object} message */ message => {
    if (typeof message === 'string' || message instanceof Buffer) {
      message = JSON.parse(message)
    }
    if (message && message.type && !closed) {
      switch (message.type) {
        case 'subscribe':
          /** @type {Array<string>} */ (message.topics || []).forEach(topicName => {
            if (typeof topicName === 'string') {
              // add conn to topic
              const topic = map.setIfUndefined(topics, topicName, () => new Set())
              topic.add(conn)
              // add topic to conn
              subscribedTopics.add(topicName)
            }
          })
          break
        case 'unsubscribe':
          /** @type {Array<string>} */ (message.topics || []).forEach(topicName => {
            const subs = topics.get(topicName)
            if (subs) {
              subs.delete(conn)
            }
          })
          break
        case 'publish':
          if (message.topic) {
            const receivers = topics.get(message.topic)
            if (receivers) {
              message.clients = receivers.size
              receivers.forEach(receiver =>
                send(receiver, message)
              )
            }
          }
          break
        case 'ping':
          send(conn, { type: 'pong' })
      }
    }
  })
}
wss.on('connection', onconnection);

server.on('upgrade', async (request, socket, head) => {
  // Allow connections only from the app domain
  // cookie is not available in the request headers from app.gomarketplan to the websocket server
  if (request?.headers?.origin === "https://app.gomarketplan.io") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
    return;
  }

  // Extract token from WebSocket cookie
  const cookieString = request?.headers?.cookie ?? '';
  let token;

  if (cookieString) {
    // Parse cookies string to find token
    const cookies = cookieString.split(';').reduce((cookiesObj, cookie) => {
      const [key, value] = cookie.trim().split('=');
      cookiesObj[key] = value;
      return cookiesObj;
    }, {});

    // Get token from parsed cookies
    token = cookies['teamAccessToken'];
  }

  if (!token) {
    console.error('Unauthorized connection: No token');
    socket.destroy();
    return;
  }

  const userId = await authenticateToken(token);

  if (!userId) {
    console.error('Unauthorized connection: Invalid token');
    socket.destroy();
    return;
  }

  console.log(`Authenticated user: ${userId}`);

  wss.handleUpgrade(request, socket, head, (ws) => {
    ws.userId = userId; // Store userId in WebSocket instance
    wss.emit('connection', ws, request);
  });
});

server.listen(port)