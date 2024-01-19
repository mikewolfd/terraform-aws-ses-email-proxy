# Terraform AWS SES Email Two-Way Proxy

This module configures Amazon SES to forward emails to existing accounts (gmail or etc). It also adds the necessary infrastructure to make this a full email proxy. You can send and receive legitimate and dkim verified emails using this module without needing to pay for a email server/service. This supports multiple email accounts.

This module will configure the following resources:

* DNS verification, DKIM and MX domains.
* SES rule set to save the incoming emails to S3 and to execute a Lambda.
  * Auto-deletes emails from s3 upon forwarding
* Lambda that will forward the email to destinations.
* A mailFrom domain to avoid spam filters.
* Verified email addresses to send emails using the domain.
* SMTP accounts to send emails using the domain.
* Outputs SMTP credentials for the users.

This module implements the official solution by AWS: 
https://aws.amazon.com/blogs/messaging-and-targeting/forward-incoming-email-to-an-external-destination/

## Arguments

| Name               | Type   | Required | Default         | Description                                          |
|--------------------|--------|----------|-----------------|------------------------------------------------------|
| `s3_bucket`        | String | Yes      |                 | S3 Bucket where emails will temp be stored           |
| `emails`           | Map    | Yes      |                 | Key/Value map of aliased emails, and destinations    |
| `domain`           | String | Yes      |                 | Domain to configure (ex: deeb.whatever)                |
| `s3_bucket_prefix` | String | No       |                 | Path inside the bucket where emails will be stored   |
| `prefix`           | String | No       | `email-forward` | All resources will be tagged using this prefix name  |
| `aws_region`       | String | No       | `us-east-1`     | AWS region where we should configure the integration |

## Attributes

| Name            | Type             | Description
|-----------------|------------------|-----------------------------------------------|
| `smtp_password` | List(Map)        | Outputs the SMTP Account details for the user.


## Example 

Let's imagine I want to configure `hello@deeb.whatever` domain to be available to the world, but I don't want to pay for an email service. 

I can use this module to register this email and send all incoming emails to my personal Gmail, from which I can reply through SMTP as `hello@deeb.whatever`. 

```
module "ses-email-forwarding" {
    source = "git@github.com:mikewolfd/terraform-aws-ses-email-proxy.git"

    domain           = "aleix.cloud"
    s3_bucket        = "amurtra"
    s3_bucket_prefix = "emails"
    emails           = {"lol": "randomDude@xyz.com", "zzz@alexis.cloud": "randomPerson@bbb.com"}
    aws_region       = "eu-east-1"
}
```

## Contributors

All contributors are more than welcome :)

## TODO

* I think I missed some of the DNS verification records for the validated email accounts.
