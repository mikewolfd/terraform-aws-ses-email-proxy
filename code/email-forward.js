"use strict";

var AWS = require("aws-sdk");

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
  // Remove whitespace, newlines, tabs, and control characters
  return email.replace(/[\s\r\n\t]+/g, "").trim();
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
exports.processMessage = function (data) {
  const match = data.emailData.match(/^((?:.+\r?\n)*)\r?\n([\s\S]*)/m);
  const header = match && match[1] ? match[1] : data.emailData;
  const body = match && match[2] ? match[2] : "";

  const emailData = {};

  for (const recipient in data.recipients) {
    let from = "";
    let recipientHeader = header;
    // Add "Reply-To:" with the "From" address if it doesn't already exists
    if (!/^reply-to:[\t ]?/im.test(recipientHeader)) {
      const match = recipientHeader.match(
        /^from:[\t ]?(.*(?:\r?\n\s+.*)*\r?\n)/im
      );
      from = match && match[1] ? match[1] : "";
      if (from) {
        // Extract just the email address from the From header and sanitize
        const fromEmailMatch = from.match(/<([^>]+)>/);
        let fromEmail = fromEmailMatch ? fromEmailMatch[1] : from.trim();
        fromEmail = sanitizeEmail(fromEmail);
        recipientHeader =
          recipientHeader +
          'Reply-To: "Original Sender" <' +
          fromEmail +
          ">\r\n";
        data.log({
          level: "info",
          message: "Added Reply-To address of: " + fromEmail,
        });
      } else {
        data.log({
          level: "info",
          message:
            "Reply-To address not added because From address was not " +
            "properly extracted.",
        });
      }
    }

    // SES does not allow sending messages from an unverified address,
    // so replace the message's "From:" header with the original
    // recipient (which is a verified domain)
    recipientHeader = recipientHeader.replace(
      /^from:[\t ]?(.*(?:\r?\n\s+.*)*)/gim,
      function (match, from) {
        let fromText;
        // Extract display name (if any) and sanitize recipient
        let displayName = from.replace(/<.*?>/, "").trim();
        let sanitizedRecipient = sanitizeEmail(recipient);
        fromText =
          'From: "' +
          displayName +
          " via " +
          sanitizedRecipient.split("@")[0] +
          '" <' +
          sanitizedRecipient +
          ">";
        return fromText;
      }
    );

    // Add a prefix to the Subject
    if (data.config.subjectPrefix) {
      recipientHeader = recipientHeader.replace(
        /^subject:[\t ]?(.*)/gim,
        function (match, subject) {
          return "Subject: " + data.config.subjectPrefix + subject;
        }
      );
    }

    // Replace original 'To' header with a manually defined one
    // Sanitize all destination addresses
    const sanitizedTo = data.recipients[recipient].map(sanitizeEmail).join(",");
    recipientHeader = recipientHeader.replace(
      /^to:[\t ]?(.*)/gim,
      "To: " + sanitizedTo
    );

    // Remove the Return-Path header.
    recipientHeader = recipientHeader.replace(
      /^return-path:[\t ]?(.*)\r?\n/gim,
      ""
    );

    // Remove Sender header.
    recipientHeader = recipientHeader.replace(/^sender:[\t ]?(.*)\r?\n/gim, "");

    // Remove Message-ID header.
    recipientHeader = recipientHeader.replace(
      /^message-id:[\t ]?(.*)\r?\n/gim,
      ""
    );

    // Remove all DKIM-Signature headers to prevent triggering an
    // "InvalidParameterValue: Duplicate header 'DKIM-Signature'" error.
    // These signatures will likely be invalid anyways, since the From
    // header was modified.
    recipientHeader = recipientHeader.replace(
      /^dkim-signature:[\t ]?.*\r?\n(\s+.*\r?\n)*/gim,
      ""
    );

    recipientHeader = recipientHeader.replace(
      /^list-id:[\t ]?.*\r?\n(\s+.*\r?\n)*/gim,
      ""
    );
    // 1. Add a List-Id header to help with email filtering
    recipientHeader =
      recipientHeader.trim() +
      "\r\nList-Id: Forwarded emails via " +
      sanitizeEmail(recipient.split("@")[1]) +
      " <bounce." +
      sanitizeEmail(recipient.split("@")[1]) +
      ">\r\n";

    // // 2. Add X-Forwarded-For header to maintain transparency
    recipientHeader = recipientHeader.replace(
      /^x-forwarded-for:[\t ]?.*\r?\n(\s+.*\r?\n)*/gim,
      ""
    );
    // Use sanitized fromEmail for X-Forwarded-For
    let fromEmailForXFF = "";
    if (from) {
      const fromEmailMatch = from.match(/<([^>]+)>/);
      fromEmailForXFF = fromEmailMatch ? fromEmailMatch[1] : from.trim();
      fromEmailForXFF = sanitizeEmail(fromEmailForXFF);
    }
    recipientHeader =
      recipientHeader.trim() +
      "\r\nX-Forwarded-For: " +
      fromEmailForXFF +
      "\r\n";

    if (data.ccRecipients.length > 0) {
      // Remove existing CC header
      // Sanitize all CC addresses
      const sanitizedCC = data.ccRecipients.map(sanitizeEmail).join(",");
      recipientHeader = recipientHeader.replace(
        /^cc:[\t ]?(.*)\r?\n/gim,
        "\r\nCC: " + sanitizedCC + "\r\n"
      );
    }
    emailData[recipient] = recipientHeader.trim() + "\r\n\r\n" + body;
  }
  data.emailData = emailData;
  return Promise.resolve(data);
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
exports.handler = function (event, context, callback, overrides) {
  var steps =
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
  var data = {
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
  Promise.series(steps, data)
    .then(function (data) {
      data.log({
        level: "info",
        message: "Process finished successfully.",
      });
      return data.callback();
    })
    .catch(function (err) {
      data.log({
        level: "error",
        message: "Step returned error: " + err.message,
        error: err,
        stack: err.stack,
      });
      return data.callback(new Error("Error: Step returned error."));
    });
};

Promise.series = function (promises, initValue) {
  return promises.reduce(function (chain, promise) {
    if (typeof promise !== "function") {
      return chain.then(() => {
        throw new Error("Error: Invalid promise item: " + promise);
      });
    }
    return chain.then(promise);
  }, Promise.resolve(initValue));
};
