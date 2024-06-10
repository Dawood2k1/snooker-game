let Engine = Matter.Engine,
    Render = Matter.Render,
    World = Matter.World,
    Bodies = Matter.Bodies,
    Body = Matter.Body,
    Composite = Matter.Composite,
    Events = Matter.Events,
    Mouse = Matter.Mouse,
    MouseConstraint = Matter.MouseConstraint;

let engine;
let world;
let tableWidth = 800;
let tableHeight = tableWidth / 2;
let ballDiameter = tableWidth / 36;
let pocketDiameter = ballDiameter * 1.5;

let cueBall;
let balls = [];
let pockets = [];
let mouseConstraint;
let boundaries = [];

function setup() {
  createCanvas(1000, 600);
  engine = Engine.create();
  world = engine.world;

  // Disable gravity
  engine.world.gravity.y = 0;

  drawTable();
  createBalls();
  createCueBall();
  createBoundaries();

  // Ensure the canvas element is properly initialized
  let canvasElement = document.querySelector('canvas');

  let canvasMouse = Mouse.create(canvasElement); // Pass the canvas element instead of canvas.elt
  canvasMouse.pixelRatio = pixelDensity();
  mouseConstraint = MouseConstraint.create(engine, {
    mouse: canvasMouse,
    constraint: {
      stiffness: 0.2,
      render: {
        visible: false
      }
    }
  });
  World.add(world, mouseConstraint);

  detectCollisions();
}

function draw() {
  background(0, 128, 0);
  drawTable();
  drawLines();

  // Draw pockets
  fill(0);
  for (let pocket of pockets) {
    ellipse(pocket.position.x, pocket.position.y, pocketDiameter);
  }

  // Draw cue ball
  if (cueBall) {
    fill(255);
    ellipse(cueBall.position.x, cueBall.position.y, ballDiameter);
  }

  // Draw other balls
  for (let ball of balls) {
    fill(ball.color);
    ellipse(ball.body.position.x, ball.body.position.y, ballDiameter);
  }

  Engine.update(engine);
}

function drawTable() {
  fill(0, 100, 0);
  rectMode(CENTER);
  rect(width / 2, height / 2, tableWidth, tableHeight);

  // Create pockets
  pockets = [];
  let pocketPositions = [
    { x: width / 2 - tableWidth / 2, y: height / 2 - tableHeight / 2 },
    { x: width / 2, y: height / 2 - tableHeight / 2 },
    { x: width / 2 + tableWidth / 2, y: height / 2 - tableHeight / 2 },
    { x: width / 2 - tableWidth / 2, y: height / 2 + tableHeight / 2 },
    { x: width / 2, y: height / 2 + tableHeight / 2 },
    { x: width / 2 + tableWidth / 2, y: height / 2 + tableHeight / 2 }
  ];

  for (let pos of pocketPositions) {
    pockets.push(Bodies.circle(pos.x, pos.y, pocketDiameter / 2, { isStatic: true }));
  }
  World.add(world, pockets);
}

function drawLines() {
  stroke(255);
  strokeWeight(2);

  // Center Line
  line(width / 2, height / 2 - tableHeight / 2, width / 2, height / 2 + tableHeight / 2);

  // D Zone
  noFill();
  arc(width / 2 - tableWidth / 4, height / 2, tableHeight / 2, tableHeight / 2, HALF_PI, -HALF_PI);
  line(width / 2 - tableWidth / 4, height / 2 - tableHeight / 4, width / 2 - tableWidth / 4, height / 2 + tableHeight / 4);
}

function createCueBall() {
  cueBall = Bodies.circle(width / 2 - tableWidth / 4, height / 2, ballDiameter / 2, {
    restitution: 0.9,
    friction: 0.005
  });
  World.add(world, cueBall);
}

function createBalls() {
  // Adding some red balls for collision
  for (let i = 0; i < 15; i++) {
    let x = random(width / 2, width / 2 + tableWidth / 2 - ballDiameter);
    let y = random(height / 2 - tableHeight / 2 + ballDiameter, height / 2 + tableHeight / 2 - ballDiameter);
    let ball = createBall(x, y, "red");
    balls.push(ball);
    World.add(world, ball.body);
  }
}

function createBall(x, y, color) {
  let ball = {
    body: Bodies.circle(x, y, ballDiameter / 2, {
      restitution: 0.9,
      friction: 0.005
    }),
    color: color
  };
  return ball;
}

function createBoundaries() {
  let halfThickness = 10;
  boundaries = [
    Bodies.rectangle(width / 2, height / 2 - tableHeight / 2 - halfThickness, tableWidth, halfThickness * 2, { isStatic: true }), // Top
    Bodies.rectangle(width / 2, height / 2 + tableHeight / 2 + halfThickness, tableWidth, halfThickness * 2, { isStatic: true }), // Bottom
    Bodies.rectangle(width / 2 - tableWidth / 2 - halfThickness, height / 2, halfThickness * 2, tableHeight, { isStatic: true }), // Left
    Bodies.rectangle(width / 2 + tableWidth / 2 + halfThickness, height / 2, halfThickness * 2, tableHeight, { isStatic: true }) // Right
  ];
  World.add(world, boundaries);
}

function detectCollisions() {
  Events.on(engine, 'collisionStart', function(event) {
    let pairs = event.pairs;
    for (let pair of pairs) {
      let bodyA = pair.bodyA;
      let bodyB = pair.bodyB;

      // Handle collision events here
      // For example, check if a ball is in a pocket, etc.
    }
  });
}
