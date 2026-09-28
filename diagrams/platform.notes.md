- [ ] #risk @payments->stripe What happens when Stripe times out mid-charge?
- [ ] >user #decision @events Kafka or a managed bus like SNS/SQS?
- [ ] >user Should inventory reserve stock before the payment succeeds?
- [x] @gateway->auth Does the gateway cache verified tokens?
  → Yes, for 5 min, keyed by jti
- Orders and payments talk only through the event bus.
