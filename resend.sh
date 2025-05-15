export MailS3Bucket=keeplist.io-emails
export AWS_REGION=us-east-1
export EmailsMapping='{"deeb@keeplist.io":["michael.f.deeb@gmail.com"],"sasha@keeplist.io":["sashashilko@gmail.com"],"team@keeplist.io":["michael.f.deeb@gmail.com","sashashilko@gmail.com"],"sandro@keeplist.io":["lovnicki.sandro@gmail.com"],"support@keeplist.io":["michael.f.deeb@gmail.com","sashashilko@gmail.com"],"report@keeplist.io":["michael.f.deeb@gmail.com","lovnicki.sandro@gmail.com"]}'
node resend-emails.js