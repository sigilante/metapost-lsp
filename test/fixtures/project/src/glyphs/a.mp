% LATIN SMALL LETTER A
beginfig(97);
  path bowl;
  bowl := fullcircle scaled x_height;
  z1 = (stem_width, 0);
  z1r = z1 + (penradius(right), 0);
  pickup thin_pen;
  draw bowl;
  stroke_with(bowl)(r) withcolor red;
  label.top("a", z1);
endfig;
