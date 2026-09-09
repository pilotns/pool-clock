const CX = 200;
const CY = 200;
const OUTER_RADIUS = 190;
const TICK_5MIN_LENGTH = 28;
const TICK_15MIN_LENGTH = 34;
const secondMarks = [];
let activeSecond = null;

function pointOnDial(minutes, radius) {
  const radians = ((minutes / 60) * 360 - 90) * Math.PI / 180;
  return { x: CX + radius * Math.cos(radians), y: CY + radius * Math.sin(radians) };
}

function createTicks() {
  const ticksGroup = document.getElementById('ticks');
  const fragment = document.createDocumentFragment();

  for (let i = 0; i < 12; i++) {
    const minutes = i * 5;
    const isQuarter = minutes % 15 === 0;

    const length = isQuarter ? TICK_15MIN_LENGTH : TICK_5MIN_LENGTH;
    const innerRadius = OUTER_RADIUS - length;

    const { x: x1, y: y1 } = pointOnDial(minutes, OUTER_RADIUS);
    const { x: x2, y: y2 } = pointOnDial(minutes, innerRadius);

    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', x1);
    line.setAttribute('y1', y1);
    line.setAttribute('x2', x2);
    line.setAttribute('y2', y2);
    line.setAttribute('class', isQuarter ? 'tick tick--15min' : 'tick tick--5min');
    secondMarks[minutes] = line;
    fragment.appendChild(line);
  }

  for (let minute = 0; minute < 60; minute++) {
    if (minute % 5 === 0) continue;

    const { x, y } = pointOnDial(minute, OUTER_RADIUS - 5);

    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('cx', x);
    dot.setAttribute('cy', y);
    dot.setAttribute('r', 3.2);
    dot.setAttribute('class', 'tick-dot');
    secondMarks[minute] = dot;
    fragment.appendChild(dot);
  }

  ticksGroup.appendChild(fragment);
}

function updateClock() {
  const now = new Date();
  const hours = now.getHours() % 12;
  const minutes = now.getMinutes();
  const seconds = now.getSeconds();

  const minuteAngle = (minutes + seconds / 60) * 6;
  const hourAngle = (hours + minutes / 60 + seconds / 3600) * 30;

  document.getElementById('minute-hand').style.transform = `rotate(${minuteAngle}deg)`;
  document.getElementById('hour-hand').style.transform = `rotate(${hourAngle}deg)`;
  if (seconds !== activeSecond) {
    if (activeSecond !== null) secondMarks[activeSecond].classList.remove('tick--current');
    secondMarks[seconds].classList.add('tick--current');
    activeSecond = seconds;
  }
}

createTicks();
function tick() {
  updateClock();
  setTimeout(tick, 1000 - (Date.now() % 1000));
}
tick();
