"use strict";

var AWS = require("aws-sdk");
const { simpleParser } = require("mailparser"); // ADD THIS
const MailComposer = require("nodemailer/lib/mail-composer"); // ADD THIS

console.log("AWS Lambda SES Forwarder // @arithmetric // Version 5.1.0");

// Configure the S3 bucket and key prefix for stored raw emails, and the
// mapping of email addresses to forward from and to.
//
// Expected keys/values:
//
// - subjectPrefix: Forwarded emails subject will contain this prefix
//
// - emailBucket: S3 bucket name where SES stores emails.
//
// - allowPlusSign: Enables support for plus sign suffixes on email addresses.
//   If set to `true`, the username/mailbox part of an email address is parsed
//   to remove anything after a plus sign. For example, an email sent to
//   `example+test@example.com` would be treated as if it was sent to
//   `example@example.com`.
//
// - forwardMapping: Object where the key is the lowercase email address from
//   which to forward and the value is an array of email addresses to which to
//   send the message.
//
//   To match all email addresses on a domain, use a key without the name part
//   of an email address before the "at" symbol (i.e. `@example.com`).
//
//   To match a mailbox name on all domains, use a key without the "at" symbol
//   and domain part of an email address (i.e. `info`).
//
//   To match all email addresses matching no other mapping, use "@" as a key.
var defaultConfig = {
  subjectPrefix: "",
  emailBucket: process.env.MailS3Bucket,
  emailKeyPrefix: process.env.MailS3Prefix ?? "",
  allowPlusSign: true,
  forwardMapping: JSON.parse(process.env.EmailsMapping),
};

function sanitizeEmail(email) {
  if (typeof email !== "string") {
    return ""; // Or handle as an error
  }
  // Remove all whitespace characters
  return email.replace(/\s+/g, "");
}

/**
 * Parses the SES event record provided for the `mail` and `receipients` data.
 *
 * @param {object} data - Data bundle with context, email, etc.
 *
 * @return {object} - Promise resolved with data.
 */
exports.parseEvent = function (data) {
  // Validate characteristics of a SES event record.
  if (
    !data.event ||
    !data.event.hasOwnProperty("Records") ||
    data.event.Records.length !== 1 ||
    !data.event.Records[0].hasOwnProperty("eventSource") ||
    data.event.Records[0].eventSource !== "aws:ses" ||
    data.event.Records[0].eventVersion !== "1.0"
  ) {
    data.log({
      message: "parseEvent() received invalid SES message:",
      level: "error",
      event: JSON.stringify(data.event),
    });
    return Promise.reject(new Error("Error: Received invalid SES message."));
  }

  data.email = data.event.Records[0].ses.mail;
  data.recipients = data.event.Records[0].ses.receipt.recipients;
  data.ccRecipients = data.event.Records[0].ses.receipt.commonHeaders?.cc || [];
  return Promise.resolve(data);
};

/**
 * Transforms the original recipients to the desired forwarded destinations.
 *
 * @param {object} data - Data bundle with context, email, etc.
 *
 * @return {object} - Promise resolved with data.
 */
exports.transformRecipients = function (data) {
  const newRecipients = {};
  data.recipients.forEach(function (origEmail) {
    var origEmailKey = origEmail.toLowerCase();
    if (data.config.allowPlusSign) {
      origEmailKey = origEmailKey.replace(/\+.*?@/, "@");
    }
    newRecipients[origEmailKey] = [];
    if (data.config.forwardMapping.hasOwnProperty(origEmailKey)) {
      newRecipients[origEmailKey] = newRecipients[origEmailKey].concat(
        data.config.forwardMapping[origEmailKey]
      );
    } else {
      var origEmailDomain;
      var origEmailUser;
      var pos = origEmailKey.lastIndexOf("@");
      if (pos === -1) {
        origEmailUser = origEmailKey;
      } else {
        origEmailDomain = origEmailKey.slice(pos);
        origEmailUser = origEmailKey.slice(0, pos);
      }
      if (
        origEmailDomain &&
        data.config.forwardMapping.hasOwnProperty(origEmailDomain)
      ) {
        newRecipients[origEmailKey] = newRecipients[origEmailKey].concat(
          data.config.forwardMapping[origEmailDomain]
        );
      } else if (
        origEmailUser &&
        data.config.forwardMapping.hasOwnProperty(origEmailUser)
      ) {
        newRecipients[origEmailKey] = newRecipients[origEmailKey].concat(
          data.config.forwardMapping[origEmailUser]
        );
      } else if (data.config.forwardMapping.hasOwnProperty("@")) {
        newRecipients[origEmailKey] = newRecipients[origEmailKey].concat(
          data.config.forwardMapping["@"]
        );
      }
    }
  });

  if (Object.keys(newRecipients).length === 0) {
    data.log({
      message:
        "Finishing process. No new recipients found for " +
        "original destinations: " +
        Object.keys(newRecipients).join(", "),
      level: "info",
    });
    return data.callback();
  }
  data.recipients = newRecipients;
  return Promise.resolve(data);
};

/**
 * Fetches the message data from S3 and then deletes it
 *
 * @param {object} data - Data bundle with context, email, etc.
 *
 * @return {object} - Promise resolved with data.
 */
exports.fetchMessage = function (data) {
  // Copying email object to ensure read permission

  const params = {
    Bucket: data.config.emailBucket,
    Key: data.config.emailKeyPrefix + data.email.messageId,
  };
  data.log({
    level: "info",
    message:
      "Fetching email at s3://" +
      data.config.emailBucket +
      "/" +
      data.config.emailKeyPrefix +
      data.email.messageId,
  });
  return new Promise(function (resolve, reject) {
    // Load the raw email from S3
    data.s3.getObject(params, function (err, result) {
      if (err) {
        data.log({
          level: "error",
          message: "getObject() returned error:",
          error: err,
          stack: err.stack,
        });
        return reject(new Error("Error: Failed to load message body from S3."));
      }
      data.emailData = result.Body.toString();
      return resolve(data);
    });
  });
};

exports.deleteMessage = function (data) {
  const params = {
    Bucket: data.config.emailBucket,
    Key: data.config.emailKeyPrefix + data.email.messageId,
  };
  data.log({
    level: "info",
    message:
      "Deleting email at s3://" +
      data.config.emailBucket +
      "/" +
      data.config.emailKeyPrefix +
      data.email.messageId,
  });
  return new Promise(function (resolve, reject) {
    data.s3.deleteObject(params, function (err, result) {
      if (err) {
        data.log({
          level: "error",
          message: "deleteObject() returned error:",
          error: err,
          stack: err.stack,
        });
        return reject(
          new Error("Error: Failed to delete message body from S3.")
        );
      }
      data.log({
        level: "info",
        message: "deleteObject() successful.",
        result: result,
      });
      return resolve(data);
    });
  });
};

/**
 * Processes the message data, making updates to recipients and other headers
 * before forwarding message.
 *
 * @param {object} data - Data bundle with context, email, etc.
 *
 * @return {object} - Promise resolved with data.
 */

exports.processMessage = async function (data) {
  const originalEmailData = data.emailData;
  const newEmailData = {};

  try {
    // 1. Parse the original raw email data
    const parsedEmail = await simpleParser(originalEmailData);

    for (const recipient in data.recipients) {
      const toAddresses = data.recipients[recipient].map(sanitizeEmail);
      const sanitizedRecipient = sanitizeEmail(recipient); // Used for the new 'From' address

      const mailOptions = {
        to: toAddresses,
        headers: [], // For custom headers not covered by direct options
      };

      // 2. Body Content (text, html, attachments)
      if (parsedEmail.text) {
        mailOptions.text = parsedEmail.text;
      }
      if (parsedEmail.html) {
        mailOptions.html = parsedEmail.html;
      }
      if (parsedEmail.attachments && parsedEmail.attachments.length > 0) {
        mailOptions.attachments = parsedEmail.attachments
          .map((att) => ({
            filename: att.filename,
            content: att.content, // Buffer from simpleParser
            cid: att.cid,
            contentDisposition: att.contentDisposition,
          }))
          .filter((att) => att.content !== undefined);
      }

      // 3. Determine original sender's information for Reply-To and X-Forwarded-For
      let originalFromDisplayName = "Original Sender";
      let originalFromEmail = ""; // This will be the actual email address part

      const originalFromHeaderValue = parsedEmail.from?.value?.[0];
      if (originalFromHeaderValue) {
        originalFromDisplayName =
          originalFromHeaderValue.name || originalFromDisplayName;
        originalFromEmail = originalFromHeaderValue.address || "";
      }
      // Sanitize and provide a fallback for the original email address
      originalFromEmail = sanitizeEmail(originalFromEmail || recipient);

      // 4. Set "From" header: SES requires sending from a verified domain.
      // The new 'From' will use the 'recipient' (which should be a verified email/domain)
      // and include the original sender's name for clarity.
      mailOptions.from = {
        name: `${originalFromDisplayName} via ${
          sanitizedRecipient.split("@")[0]
        }`,
        address: sanitizedRecipient,
      };

      // 5. Add "Reply-To" with the original "From" address if it doesn't already exist
      if (!parsedEmail.headers.get("reply-to") && originalFromEmail) {
        mailOptions.replyTo = {
          name: originalFromDisplayName, // Use the parsed or default display name
          address: originalFromEmail, // Use the sanitized original email address
        };
        data.log({
          level: "info",
          message: "Added Reply-To address of: " + originalFromEmail,
        });
      } else if (parsedEmail.headers.get("reply-to")) {
        if (parsedEmail.replyTo) {
          mailOptions.replyTo = parsedEmail.replyTo; // Use parsed replyTo object
        }
        data.log({
          level: "info",
          message: "Kept existing Reply-To address.",
        });
      } else {
        data.log({
          level: "info",
          message:
            "Reply-To address not added: original From address was not " +
            "properly extracted or an existing Reply-To was already present.",
        });
      }

      // 6. Add a prefix to the Subject
      let subject = parsedEmail.subject || "";
      if (data.config.subjectPrefix) {
        subject = data.config.subjectPrefix + subject;
      }
      mailOptions.subject = subject;

      // 7. Set "Cc" recipients
      if (data.ccRecipients && data.ccRecipients.length > 0) {
        mailOptions.cc = data.ccRecipients.map(sanitizeEmail);
      }

      // 8. Add custom headers: List-Id and X-Forwarded-For
      const listIdDomainPart = recipient.split("@")[1] || "unknown.domain";
      const sanitizedListIdDomain = sanitizeEmail(listIdDomainPart);
      mailOptions.headers.push({
        key: "List-Id",
        value: `Forwarded emails via ${sanitizedListIdDomain} <bounce.${sanitizedListIdDomain}>`,
      });

      mailOptions.headers.push({
        key: "X-Forwarded-For",
        value: originalFromEmail, // Already sanitized
      });

      // 9. Copy other relevant headers from the original email
      // Exclude headers that are explicitly set, should be removed, or are better regenerated by MailComposer.
      const excludedHeaders = new Set([
        "from",
        "to",
        "cc",
        "bcc",
        "subject",
        "reply-to", // Handled by mailOptions
        "return-path",
        "sender",
        "message-id",
        "dkim-signature", // To be removed/regenerated
        "list-id",
        "x-forwarded-for", // We are adding our own versions
        // MailComposer handles these based on content:
        "content-type",
        "content-transfer-encoding",
        "mime-version",
        "date", // MailComposer will generate a new Date header
      ]);

      if (parsedEmail.headerLines) {
        parsedEmail.headerLines.forEach((headerLine) => {
          const key = headerLine.key.toLowerCase();
          if (!excludedHeaders.has(key)) {
            // Add the header using its original key casing and unfolded value
            mailOptions.headers.push({
              key: headerLine.key,
              value: headerLine.value,
            });
          }
        });
      }

      // Remove headers with undefined or null values
      mailOptions.headers = mailOptions.headers.filter(
        (h) => h.value !== undefined && h.value !== null
      );

      // Log all headers being added to mailOptions.headers
      console.log(
        "Headers being added to mailOptions.headers:",
        mailOptions.headers
      );

      // 10. Compile the new email
      const mailComposer = new MailComposer(mailOptions);
      const messageBuffer = await new Promise((resolve, reject) => {
        mailComposer.compile().build((err, message) => {
          if (err) {
            console.log(mailOptions);
            return reject(err);
          }
          resolve(message);
        });
      });

      // Store the raw email string (as the original code did)
      newEmailData[recipient] = messageBuffer.toString();
    }
    data.emailData = newEmailData;
    return data; // Promise.resolve(data) is implicit with async function
  } catch (error) {
    data.log({
      level: "error",
      message:
        "Error processing message with MailParser/MailComposer: " +
        (error.message || error),
      error: error.stack,
    });
    // Re-throw the error to indicate failure, or handle as appropriate for your application
    throw error;
  }
};

/**
 * Send email using the SES sendRawEmail command.
 *
 * @param {object} data - Data bundle with context, email, etc.
 *
 * @return {object} - Promise resolved with data.
 */
exports.sendMessage = function (data) {
  const emails = [];
  for (const recipient in data.recipients) {
    const sanitizedSource = sanitizeEmail(recipient);
    const sanitizedDestinations = data.recipients[recipient].map(sanitizeEmail);

    var params = {
      Destinations: sanitizedDestinations,
      Source: sanitizedSource,
      RawMessage: {
        Data: data.emailData[recipient],
      },
    };
    data.log({
      level: "info",
      message:
        "sendMessage: Sending email via SES. Original recipient: " +
        sanitizedSource +
        ". Transformed recipients: " +
        sanitizedDestinations.join(", ") +
        ".",
    });
    emails.push(
      new Promise(function (resolve, reject) {
        data.log({
          level: "info",
          message: "sendRawEmail() called.",
          params: params,
        });
        data.ses.sendRawEmail(params, function (err, result) {
          if (err) {
            data.log({
              level: "error",
              message: "sendRawEmail() returned error.",
              error: err,
              stack: err.stack,
            });
            return reject(new Error("Error: Email sending failed."));
          }
          data.log({
            level: "info",
            message: "sendRawEmail() successful.",
            result: result,
          });
          resolve(data);
        });
      })
    );
  }
  return Promise.all(emails).then(() => data);
};

/**
 * Handler function to be invoked by AWS Lambda with an inbound SES email as
 * the event.
 *
 * @param {object} event - Lambda event from inbound email received by AWS SES.
 * @param {object} context - Lambda context object.
 * @param {object} callback - Lambda callback object.
 * @param {object} overrides - Overrides for the default data, including the
 * configuration, SES object, and S3 object.
 */
exports.handler = async function (event, context, callback, overrides) {
  const steps =
    overrides && overrides.steps
      ? overrides.steps
      : [
          exports.parseEvent,
          exports.transformRecipients,
          exports.fetchMessage,
          exports.processMessage,
          exports.sendMessage,
          exports.deleteMessage,
        ];
  const data = {
    event: event,
    callback: callback,
    context: context,
    config: overrides && overrides.config ? overrides.config : defaultConfig,
    log: overrides && overrides.log ? overrides.log : console.log,
    ses: overrides && overrides.ses ? overrides.ses : new AWS.SES(),
    s3:
      overrides && overrides.s3
        ? overrides.s3
        : new AWS.S3({ signatureVersion: "v4" }),
  };
  try {
    let currentData = data;
    for (const step of steps) {
      if (typeof step !== "function") {
        throw new Error("Error: Invalid promise item: " + step);
      }
      currentData = await step(currentData);
    }
    currentData.log({
      level: "info",
      message: "Process finished successfully.",
    });
    return currentData.callback();
  } catch (err) {
    data.log({
      level: "error",
      message: "Step returned error: " + err.message,
      error: err,
      stack: err.stack,
    });
    return data.callback(new Error("Error: Step returned error."));
  }
};
