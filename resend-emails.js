"use strict";

const { handler } = require("./code/email-forward.js");
const { simpleParser } = require("mailparser");

// Load config from environment or hardcode for testing
const emailBucket = process.env.MailS3Bucket;
const emailKeyPrefix = process.env.MailS3Prefix ?? "";
const emailsMapping = process.env.EmailsMapping; // Should be a JSON string

if (!emailBucket || !emailsMapping) {
  console.error("Set MailS3Bucket and EmailsMapping in your environment.");
  process.exit(1);
}

async function listAllKeys(s3, Bucket, Prefix) {
  let keys = [];
  let ContinuationToken;
  do {
    const params = { Bucket, Prefix, ContinuationToken };
    const resp = await s3.listObjectsV2(params).promise();
    keys = keys.concat(resp.Contents.map((obj) => obj.Key));
    ContinuationToken = resp.IsTruncated ? resp.NextContinuationToken : null;
  } while (ContinuationToken);
  return keys;
}

async function getRawEmail(s3, Bucket, Key) {
  const resp = await s3.getObject({ Bucket, Key }).promise();
  return resp.Body.toString();
}

async function main() {
  const AWS = require("aws-sdk");
  const s3 = new AWS.S3({ signatureVersion: "v4" });
  const keys = await listAllKeys(s3, emailBucket, emailKeyPrefix);
  console.log(`Found ${keys.length} emails in S3.`);

  for (const key of keys) {
    try {
      // Simulate SES event
      const messageId = key.replace(emailKeyPrefix, "");
      const rawEmail = await getRawEmail(s3, emailBucket, key);

      // Use mailparser to extract the 'To' address
      const parsedEmail = await simpleParser(rawEmail);
      let toAddress = null;
      if (
        parsedEmail.to &&
        parsedEmail.to.value &&
        parsedEmail.to.value.length > 0
      ) {
        toAddress = parsedEmail.to.value[0].address;
      }
      if (!toAddress) {
        console.warn(`Could not extract recipient from ${key}, skipping.`);
        continue;
      }

      // Build a fake SES event
      const event = {
        Records: [
          {
            eventSource: "aws:ses",
            eventVersion: "1.0",
            ses: {
              mail: {
                messageId,
              },
              receipt: {
                recipients: [toAddress],
                commonHeaders: {
                  to: [toAddress],
                  cc: [],
                },
              },
            },
          },
        ],
      };

      // Call the Lambda handler
      await new Promise((resolve, reject) => {
        handler(
          event,
          {}, // context
          (err) => {
            if (err) {
              console.error(`Failed to resend ${key}:`, err);
              reject(err);
            } else {
              console.log(`Successfully resent ${key}`);
              resolve();
            }
          },
          {
            // Optionally override config, s3, ses, etc.
            // config: { ... }
          }
        );
      });
      // Add a 1 second delay between each resend
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch (err) {
      console.error(`Error processing ${key}:`, err);
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}

module.exports = { main };
