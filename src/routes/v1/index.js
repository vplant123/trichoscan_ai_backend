const express = require('express');
const sessionRoute = require('./session.routes');
const reportRoute = require('./report.routes');

const router = express.Router();

const defaultRoutes = [
  {
    path: '/sessions',
    route: sessionRoute,
  },
  {
    path: '/reports',
    route: reportRoute,
  },
];

defaultRoutes.forEach((route) => {
  router.use(route.path, route.route);
});

module.exports = router;
